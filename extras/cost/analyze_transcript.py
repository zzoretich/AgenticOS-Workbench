#!/usr/bin/env python3
"""AgenticOS cost analyzer — forensic per-skill token-cost analysis of a Claude Code transcript.

Pure functions + a CLI. No network at import time. The only optional network call
(count_tokens, to split co-loaded skills) is dependency-injected so tests run offline.
"""
import argparse
import hashlib
import json
import os
from datetime import datetime


def _iter_json_lines(path):
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def load_turns(jsonl_path):
    """Ordered assistant turns with their usage ledger. Always returns the full key set.

    De-duplicates by `message.id`: a single billed API response can be split across
    multiple JSONL lines (one per content-block type, e.g. thinking/tool_use/text).
    On most transcripts seen so far (e.g. claude-opus-5 sessions) every line for a
    given id carries an IDENTICAL copy of `usage`, so keeping just one is safe.

    But this is not universal: on at least one claude-sonnet-5 in-process-subagent
    transcript (discovered 2026-08-04 auditing a weekly-brief-sonnet teammate run),
    `usage` is instead an INCREMENTAL streaming snapshot — input/cache_read/
    cache_creation stay constant across a message id's lines, but `output_tokens`
    grows line-by-line and only the LAST line carries the true final (billed) total
    (e.g. one turn's lines read output_tokens 3, 3, 3, 3, 3, 3, 7372 — taking the
    first line alone would undercount that turn's output by >99%).

    To be correct under both behaviors, later lines sharing a `message.id` are no
    longer discarded: each numeric usage field is MERGED via max() against what's
    already recorded for that id. This is a no-op when duplicates are truly
    identical (max of equal values == that value) and recovers the true total when
    they are incremental snapshots. `cache_breakdown_present` is OR'd in the same way.
    Lines with no `message.id` (e.g. synthetic/test fixtures) are never treated as
    duplicates of each other.
    """
    turns = []
    seen_ids = {}
    idx = 0
    for o in _iter_json_lines(jsonl_path):
        if o.get("type") != "assistant":
            continue
        msg = o.get("message", {}) or {}
        mid = msg.get("id")
        usage = msg.get("usage")

        if mid is not None and mid in seen_ids:
            rec = turns[seen_ids[mid]]
            if usage:
                rec["usage_present"] = True
                rec["service_tier"] = rec["service_tier"] or (usage.get("service_tier", "") or "")
                rec["input_tokens"] = max(rec["input_tokens"], usage.get("input_tokens", 0) or 0)
                rec["cache_creation_input_tokens"] = max(
                    rec["cache_creation_input_tokens"], usage.get("cache_creation_input_tokens", 0) or 0
                )
                rec["cache_read_input_tokens"] = max(
                    rec["cache_read_input_tokens"], usage.get("cache_read_input_tokens", 0) or 0
                )
                rec["output_tokens"] = max(rec["output_tokens"], usage.get("output_tokens", 0) or 0)
                breakdown = usage.get("cache_creation")
                if isinstance(breakdown, dict):
                    rec["cache_breakdown_present"] = True
                    rec["cache_creation_5m"] = max(
                        rec["cache_creation_5m"], breakdown.get("ephemeral_5m_input_tokens", 0) or 0
                    )
                    rec["cache_creation_1h"] = max(
                        rec["cache_creation_1h"], breakdown.get("ephemeral_1h_input_tokens", 0) or 0
                    )
                elif not rec["cache_breakdown_present"]:
                    rec["cache_creation_5m"] = rec["cache_creation_input_tokens"]
                    rec["cache_creation_1h"] = 0
            continue

        rec = {
            "index": idx,
            "model": msg.get("model", "") or "",
            "service_tier": "",
            "usage_present": bool(usage),
            "input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "output_tokens": 0,
            "cache_creation_5m": 0,
            "cache_creation_1h": 0,
            "cache_breakdown_present": False,
        }
        if usage:
            rec["service_tier"] = usage.get("service_tier", "") or ""
            rec["input_tokens"] = usage.get("input_tokens", 0) or 0
            rec["cache_creation_input_tokens"] = usage.get("cache_creation_input_tokens", 0) or 0
            rec["cache_read_input_tokens"] = usage.get("cache_read_input_tokens", 0) or 0
            rec["output_tokens"] = usage.get("output_tokens", 0) or 0
            breakdown = usage.get("cache_creation")
            if isinstance(breakdown, dict):
                rec["cache_breakdown_present"] = True
                rec["cache_creation_5m"] = breakdown.get("ephemeral_5m_input_tokens", 0) or 0
                rec["cache_creation_1h"] = breakdown.get("ephemeral_1h_input_tokens", 0) or 0
            else:
                rec["cache_creation_5m"] = rec["cache_creation_input_tokens"]
                rec["cache_creation_1h"] = 0
        turns.append(rec)
        if mid is not None:
            seen_ids[mid] = idx
        idx += 1
    return turns


def _rate(pricing, model):
    m = pricing["models"].get(model) or pricing["models"][pricing["default_model"]]
    return m["in"] / 1_000_000.0, m["out"] / 1_000_000.0


def cost_of_turn(turn, pricing):
    """Exact dollar cost of one turn from its billed usage. Returns 0.0 if no usage."""
    if not turn.get("usage_present"):
        return 0.0
    rin, rout = _rate(pricing, turn["model"])
    c = pricing["cache"]
    return (
        turn["input_tokens"] * rin
        + turn["cache_creation_5m"] * rin * c["write_5m_mult"]
        + turn["cache_creation_1h"] * rin * c["write_1h_mult"]
        + turn["cache_read_input_tokens"] * rin * c["read_mult"]
        + turn["output_tokens"] * rout
    )


def _text_of_message(msg):
    """Flatten a message's content to plain text (string or list-of-text-blocks)."""
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str):
                parts.append(b["text"])
        return "\n".join(parts)
    return ""


def _is_skill_launch_stub(msg):
    content = msg.get("content")
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_result":
                txt = b.get("content")
                if isinstance(txt, str) and txt.startswith("Launching skill:"):
                    return True
    return False


def detect_skill_loads(jsonl_path):
    """Ordered skill loads: name, the assistant turn that called Skill, and the literal
    injected body text (next user message that is not the launch stub).

    `call_turn` is expressed in the SAME de-duplicated turn-index space that
    `load_turns()` produces (see its docstring): multiple JSONL lines sharing one
    `message.id` collapse to a single index, so a Skill tool_use landing on any one
    of those lines still resolves to the correct booking turn.
    """
    lines = list(_iter_json_lines(jsonl_path))
    asst_index_at = {}
    seen_ids = {}
    ai = 0
    for pos, o in enumerate(lines):
        if o.get("type") != "assistant":
            continue
        mid = (o.get("message", {}) or {}).get("id")
        if mid is not None and mid in seen_ids:
            asst_index_at[pos] = seen_ids[mid]
            continue
        asst_index_at[pos] = ai
        if mid is not None:
            seen_ids[mid] = ai
        ai += 1
    loads = []
    for pos, o in enumerate(lines):
        if o.get("type") != "assistant":
            continue
        content = o.get("message", {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == "Skill":
                name = (b.get("input") or {}).get("skill")
                if not name:
                    continue
                injected = None
                for later in lines[pos + 1:]:
                    if later.get("type") != "user":
                        continue
                    msg = later.get("message", {}) or {}
                    if _is_skill_launch_stub(msg):
                        continue
                    txt = _text_of_message(msg)
                    if txt:
                        injected = txt
                        break
                loads.append({"skill_name": name, "call_turn": asst_index_at[pos],
                              "injected_text": injected})
    return loads


def count_tokens_real(text, model):
    """Real Anthropic tokenizer count. Returns None if SDK/key unavailable (caller degrades)."""
    if not text:
        return None
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
    except ImportError:
        return None
    try:
        client = anthropic.Anthropic()
        resp = client.messages.count_tokens(
            model=model, messages=[{"role": "user", "content": text}]
        )
        return resp.input_tokens
    except Exception:
        return None


def split_load(co_loads, billed_tokens, counter):
    """Split a turn's billed cache_creation across the skills that loaded on it.

    counter: callable(text)->int|None (dependency-injected; real tokenizer or fake).
    Returns {skill_name: (tokens:int, label:str)}.
    """
    if len(co_loads) == 1:
        return {co_loads[0]["skill_name"]: (int(billed_tokens), "billed")}

    counts = {}
    label = "tokenizer-split"
    for s in co_loads:
        t = counter(s["injected_text"]) if s.get("injected_text") else None
        if t is None:
            label = "len-split"
            break
        counts[s["skill_name"]] = t

    if label == "len-split":
        counts = {s["skill_name"]: max(len(s.get("injected_text") or ""), 1) for s in co_loads}

    total = sum(counts.values()) or 1
    return {name: (int(round(billed_tokens * c / total)), label) for name, c in counts.items()}


def amortize(turns, loads_by_turn):
    """Per-skill amortized cache-read TOKENS (model/price-agnostic; see amortize_cost
    for the priced version used by attribute_skills).

    loads_by_turn: {load_turn_index: {skill_name: load_size_tokens}}. A skill becomes
    resident on its load turn and shares every LATER turn's measured cache_read by its size.
    Per the design note, resident_tokens_t := turn.cache_read_input_tokens (the actual
    re-read prefix), so each resident skill's per-turn share equals its own size.
    """
    resident = {}  # skill_name -> size
    amortized = {}
    for t in turns:
        cr = t["cache_read_input_tokens"]
        if cr > 0 and resident:
            for name, size in resident.items():
                share = size / cr
                amortized[name] = amortized.get(name, 0) + int(round(cr * share))
        for name, size in loads_by_turn.get(t["index"], {}).items():
            resident[name] = resident.get(name, 0) + size
            amortized.setdefault(name, 0)
    return amortized


def amortize_cost(turns, loads_by_turn, pricing):
    """Per-skill amortized DOLLAR cost, mirroring amortize()'s residency logic but
    pricing each turn's re-read share with that turn's REAL model rate (not a
    hardcoded default_model), since cache-read cost is billed at whatever model
    served that turn.
    """
    resident = {}
    cost = {}
    read_mult = pricing["cache"]["read_mult"]
    for t in turns:
        cr = t["cache_read_input_tokens"]
        if cr > 0 and resident:
            rin_t, _ = _rate(pricing, t["model"])
            for name, size in resident.items():
                share = size / cr
                cost[name] = cost.get(name, 0.0) + (cr * share) * rin_t * read_mult
        for name, size in loads_by_turn.get(t["index"], {}).items():
            resident[name] = resident.get(name, 0) + size
            cost.setdefault(name, 0.0)
    return cost


def _next_usage_turn_index(turns, after_index):
    """Index of the first turn with usage strictly after `after_index`, else None."""
    for t in turns:
        if t["index"] > after_index and t["usage_present"] and \
           (t["cache_creation_input_tokens"] > 0 or t["cache_creation_5m"] > 0):
            return t["index"]
    return None


def attribute_skills(turns, loads, counter, pricing):
    """Per-skill LOAD (billed cache_creation, split if co-loaded) + AMORTIZED (cache-read share).

    Both dollar figures are priced using the REAL model and REAL 5m/1h write-mix of the
    turn(s) that earned them (not pricing["default_model"] and not a hardcoded 5m
    multiplier) — a skill loaded/re-read under a non-default model is billed at that
    model's rate.
    """
    by_index = {t["index"]: t for t in turns}
    cache = pricing["cache"]

    booking = {}      # booking_turn_index -> list of load records
    unattributed = []
    for ld in loads:
        bt = _next_usage_turn_index(turns, ld["call_turn"])
        if bt is None:
            unattributed.append(ld)
        else:
            booking.setdefault(bt, []).append(ld)

    load_tokens = {}   # skill -> tokens
    load_label = {}    # skill -> label
    load_cost = {}      # skill -> dollars (priced per-booking-turn, real model + write-mix)
    loads_by_turn = {} # booking_turn -> {skill: size}  (feeds amortize/amortize_cost)
    for bt, co in booking.items():
        t = by_index[bt]
        billed = t["cache_creation_input_tokens"] or t["cache_creation_5m"]
        split = split_load(co, billed, counter)
        rin_t, _ = _rate(pricing, t["model"])
        cc5, cc1 = t["cache_creation_5m"], t["cache_creation_1h"]
        denom = cc5 + cc1
        blended_write_mult = (
            (cc5 * cache["write_5m_mult"] + cc1 * cache["write_1h_mult"]) / denom
            if denom > 0 else cache["write_5m_mult"]
        )
        loads_by_turn[bt] = {}
        for name, (tok, label) in split.items():
            load_tokens[name] = load_tokens.get(name, 0) + tok
            load_label[name] = label
            load_cost[name] = load_cost.get(name, 0.0) + tok * rin_t * blended_write_mult
            loads_by_turn[bt][name] = loads_by_turn[bt].get(name, 0) + tok

    amortized_tokens = amortize(turns, loads_by_turn)
    amortized_costs = amortize_cost(turns, loads_by_turn, pricing)

    rows = []
    names = set(load_tokens) | set(amortized_tokens) | {u["skill_name"] for u in unattributed}
    for name in sorted(names):
        lt = load_tokens.get(name, 0)
        label = load_label.get(name, "unattributed" if name in {u["skill_name"] for u in unattributed} else "billed")
        lc = load_cost.get(name, 0.0)
        at = amortized_tokens.get(name, 0)
        ac = amortized_costs.get(name, 0.0)
        rows.append({
            "name": name,
            "load_tokens": lt, "load_cost": lc, "load_label": label,
            "amortized_tokens": at, "amortized_cost": ac,
            "total_cost": lc + ac,
        })
    rows.sort(key=lambda r: r["total_cost"], reverse=True)
    return rows


def skillset_hash(names):
    joined = "\n".join(sorted(set(names)))
    return hashlib.sha1(joined.encode("utf-8")).hexdigest()


def diff_snapshots(current, previous):
    """Per-skill deltas vs previous snapshot. {} if previous is None."""
    if not previous:
        return {}
    prev = {s["name"]: s for s in previous.get("skills", [])}
    out = {}
    for s in current.get("skills", []):
        p = prev.get(s["name"])
        if p is None:
            out[s["name"]] = {"d_cost": s["total_cost"], "d_load_tokens": s["load_tokens"],
                              "d_amortized_tokens": s["amortized_tokens"], "is_new": True}
        else:
            out[s["name"]] = {
                "d_cost": s["total_cost"] - p["total_cost"],
                "d_load_tokens": s["load_tokens"] - p.get("load_tokens", 0),
                "d_amortized_tokens": s["amortized_tokens"] - p.get("amortized_tokens", 0),
                "is_new": False,
            }
    return out


def build_report(jsonl_path, pricing, prev_snapshot, counter):
    """Full report JSON the HTML consumes (snapshot fields + diff + footer flags)."""
    turns = load_turns(jsonl_path)
    loads = detect_skill_loads(jsonl_path)
    skills = attribute_skills(turns, loads, counter, pricing)

    per_turn_cost = [round(cost_of_turn(t, pricing), 6) for t in turns]
    total_cost = round(sum(per_turn_cost), 6)
    total_tokens = sum(t["input_tokens"] + t["cache_creation_input_tokens"]
                       + t["cache_read_input_tokens"] + t["output_tokens"] for t in turns)
    cache_read_tokens = sum(t["cache_read_input_tokens"] for t in turns)
    savings = 0.0
    for t in turns:
        rin, _ = _rate(pricing, t["model"])
        savings += t["cache_read_input_tokens"] * rin * (1 - pricing["cache"]["read_mult"])

    model_mix = {}
    for t in turns:
        if t["usage_present"]:
            model_mix[t["model"]] = model_mix.get(t["model"], 0) + 1

    flags = []
    n_no_usage = sum(1 for t in turns if not t["usage_present"])
    if n_no_usage:
        flags.append(f"{n_no_usage} turn(s) lacked usage data (excluded from cost).")
    if any(not t["cache_breakdown_present"] and t["cache_creation_input_tokens"] for t in turns):
        flags.append("Some turns lacked the 5m/1h cache_creation breakdown (assumed 5m write).")
    labels = {s["load_label"] for s in skills}
    if "len-split" in labels:
        flags.append("A co-load was split by character length (no API key); accuracy reduced for that turn.")
    if "unattributed" in labels:
        flags.append("A skill load could not be attributed to a billed turn.")
    known_models = set(pricing["models"].keys())
    unknown_models = sorted({t["model"] for t in turns if t["usage_present"] and t["model"] not in known_models})
    if unknown_models:
        flags.append(
            f"Model(s) {', '.join(unknown_models)} have no pricing.json entry; "
            f"defaulted to {pricing['default_model']} rates. Verify and add a real rate."
        )

    skillset = [s["name"] for s in skills]
    report = {
        "generated": datetime.now().isoformat(timespec="seconds"),
        "transcript": os.path.basename(jsonl_path),
        "project": os.path.basename(os.path.dirname(jsonl_path)),
        "model_mix": model_mix,
        "totals": {
            "tokens": total_tokens, "cost_usd": total_cost, "turns": len(turns),
            "cache_read_tokens": cache_read_tokens, "cache_savings_usd": round(savings, 6),
        },
        "skills": skills,
        "per_turn_cost": per_turn_cost,
        "skillset_hash": skillset_hash(skillset),
        "rates_as_of": pricing.get("rates_as_of", "unknown"),
        "flags": flags,
        "diff": diff_snapshots({"skills": skills}, prev_snapshot),
    }
    return report


def find_latest_snapshot(snapshots_dir, skillset_hash_value, exclude=None):
    """Most recent committed snapshot with a matching skillset_hash, else None."""
    if not os.path.isdir(snapshots_dir):
        return None
    candidates = []
    for fn in os.listdir(snapshots_dir):
        if not fn.endswith(".json"):
            continue
        full = os.path.join(snapshots_dir, fn)
        if exclude and os.path.abspath(full) == os.path.abspath(exclude):
            continue
        try:
            with open(full) as f:
                snap = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        if snap.get("skillset_hash") == skillset_hash_value:
            candidates.append((snap.get("generated", ""), snap))
    if not candidates:
        return None
    candidates.sort(key=lambda c: c[0], reverse=True)
    return candidates[0][1]


def write_snapshot(report, snapshots_dir):
    os.makedirs(snapshots_dir, exist_ok=True)
    ts = report["generated"].replace(":", "").replace("-", "")
    snap = {k: v for k, v in report.items() if k != "diff"}
    path = os.path.join(snapshots_dir, f"{ts}__{report['skillset_hash'][:8]}.json")
    with open(path, "w") as f:
        json.dump(snap, f, indent=2)
    return path


def _load_pricing(path):
    with open(path) as f:
        return json.load(f)


def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="AgenticOS cost analyzer — forensic token-cost analysis of one Claude Code transcript.")
    ap.add_argument("--transcript", required=True)
    ap.add_argument("--pricing", default=os.path.join(here, "pricing.json"))
    ap.add_argument("--prev", default="auto", help='"auto" | path to prior snapshot | "none"')
    ap.add_argument("--out", default=None, help="write report JSON here")
    ap.add_argument("--html-out", default=None, help="write rendered HTML report here")
    ap.add_argument("--no-api", action="store_true", help="force len-split (skip count_tokens)")
    ap.add_argument("--snapshots-dir", default=os.path.join(here, "data", "snapshots"),
                    help="where snapshot JSON files accumulate (auto-cost.js passes <vault>/brain/_index/cost/snapshots)")
    args = ap.parse_args(argv)

    if not os.path.isfile(args.transcript):
        ap.error(f"transcript not found: {args.transcript}")

    pricing = _load_pricing(args.pricing)
    counter = (lambda t: None) if args.no_api else (lambda t: count_tokens_real(t, pricing["default_model"]))

    snapshots_dir = args.snapshots_dir
    prelim = build_report(args.transcript, pricing, None, counter)
    if args.prev == "auto":
        prev = find_latest_snapshot(snapshots_dir, prelim["skillset_hash"])
    elif args.prev == "none":
        prev = None
    else:
        with open(args.prev) as f:
            prev = json.load(f)

    report = build_report(args.transcript, pricing, prev, counter)
    snap_path = write_snapshot(report, snapshots_dir)
    report["_snapshot_path"] = snap_path

    if args.out:
        with open(args.out, "w") as f:
            json.dump(report, f, indent=2)

    if args.html_out:
        template_path = os.path.join(here, "report-template.html")
        with open(template_path) as f:
            template = f.read()
        with open(args.html_out, "w") as f:
            f.write(render_html(report, template))

    heaviest = report["skills"][0]["name"] if report["skills"] else "(none)"
    print(f"tokens={report['totals']['tokens']} cost=${report['totals']['cost_usd']:.4f} "
          f"heaviest={heaviest} snapshot={os.path.basename(snap_path)}")
    return report


def _fmt_int(n):
    return f"{int(round(n)):,}"


def _fmt_usd(x):
    return f"{x:.4f}"


def _delta_cell(diff_row):
    if not diff_row:
        return "<span class='delta-down'>—</span>"
    dc = diff_row["d_cost"]
    if diff_row.get("is_new"):
        return "<span class='delta-up'>new</span>"
    arrow, cls = ("▲", "delta-up") if dc > 0 else ("▼", "delta-down") if dc < 0 else ("=", "")
    return f"<span class='{cls}'>{arrow} ${abs(dc):.4f}</span>"


def render_html(report, template):
    """Deterministically fill the branded template from the report JSON. No model authoring."""
    t = report["totals"]
    diff = report.get("diff", {})

    rows = []
    for s in report["skills"]:
        rows.append(
            "<tr>"
            f"<td>{s['name']}</td>"
            f"<td class='num'>{_fmt_int(s['load_tokens'])}</td>"
            f"<td class='num'>${_fmt_usd(s['load_cost'])}</td>"
            f"<td><span class='badge {s['load_label']}'>{s['load_label']}</span></td>"
            f"<td class='num'>{_fmt_int(s['amortized_tokens'])}</td>"
            f"<td class='num'>${_fmt_usd(s['amortized_cost'])}</td>"
            f"<td class='num'>${_fmt_usd(s['total_cost'])}</td>"
            f"<td>{_delta_cell(diff.get(s['name']))}</td>"
            "</tr>"
        )
    skill_rows = "".join(rows) if rows else \
        "<tr><td colspan='8'>No skills detected in this transcript.</td></tr>"

    heaviest = report["skills"][:3]
    heaviest_rows = "".join(
        f"<tr><td>{s['name']}</td><td class='num'>${_fmt_usd(s['total_cost'])}</td>"
        f"<td class='num'>load ${_fmt_usd(s['load_cost'])} · amort ${_fmt_usd(s['amortized_cost'])}</td></tr>"
        for s in heaviest
    ) or "<tr><td>No skills to rank.</td></tr>"

    costs = report.get("per_turn_cost", [])
    peak = max(costs) if costs else 1
    spark = "".join(
        f"<div class='bar' style='height:{max(2, int((c / peak) * 80)) if peak else 2}px' "
        f"title='${c:.4f}'></div>"
        for c in costs
    ) or "<span class='sub'>no per-turn cost data</span>"

    flags = "".join(f"<li>{f}</li>" for f in report.get("flags", []))
    model_mix = ", ".join(f"{m.split('-')[1] if '-' in m else m}×{n}"
                          for m, n in report.get("model_mix", {}).items()) or "—"

    replacements = {
        "{{TRANSCRIPT}}": report.get("transcript", ""),
        "{{GENERATED}}": report.get("generated", ""),
        "{{TOTAL_TOKENS}}": _fmt_int(t["tokens"]),
        "{{TOTAL_COST}}": _fmt_usd(t["cost_usd"]),
        "{{CACHE_SAVINGS}}": _fmt_usd(t["cache_savings_usd"]),
        "{{TURNS}}": str(t["turns"]),
        "{{MODEL_MIX}}": model_mix,
        "{{SKILL_ROWS}}": skill_rows,
        "{{HEAVIEST_ROWS}}": heaviest_rows,
        "{{SPARKLINE}}": spark,
        "{{FLAGS}}": flags,
        "{{RATES_AS_OF}}": report.get("rates_as_of", "unknown"),
    }
    out = template
    for k, v in replacements.items():
        out = out.replace(k, str(v))
    return out


if __name__ == "__main__":
    main()
