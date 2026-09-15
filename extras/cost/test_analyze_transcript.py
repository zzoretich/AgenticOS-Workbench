import json, os, tempfile, unittest
import analyze_transcript as az


def write_jsonl(lines):
    fd, path = tempfile.mkstemp(suffix=".jsonl")
    with os.fdopen(fd, "w") as f:
        for o in lines:
            f.write(json.dumps(o) + "\n")
    return path


def asst(model, usage):
    return {"type": "assistant", "message": {"model": model, "content": [], "usage": usage}}


class TestLoadTurns(unittest.TestCase):
    def test_parses_usage_and_breakdown(self):
        path = write_jsonl([
            asst("claude-sonnet-4-6", {
                "input_tokens": 6, "cache_creation_input_tokens": 76559,
                "cache_read_input_tokens": 0, "output_tokens": 183,
                "service_tier": "standard",
                "cache_creation": {"ephemeral_5m_input_tokens": 76559, "ephemeral_1h_input_tokens": 0},
            }),
        ])
        turns = az.load_turns(path)
        self.assertEqual(len(turns), 1)
        t = turns[0]
        self.assertEqual(t["index"], 0)
        self.assertTrue(t["usage_present"])
        self.assertEqual(t["cache_creation_5m"], 76559)
        self.assertEqual(t["cache_creation_1h"], 0)
        self.assertTrue(t["cache_breakdown_present"])
        self.assertEqual(t["model"], "claude-sonnet-4-6")

    def test_missing_breakdown_falls_back(self):
        path = write_jsonl([
            asst("claude-opus-4-8", {
                "input_tokens": 1, "cache_creation_input_tokens": 1000,
                "cache_read_input_tokens": 0, "output_tokens": 5, "service_tier": "standard",
            }),
        ])
        t = az.load_turns(path)[0]
        self.assertFalse(t["cache_breakdown_present"])
        self.assertEqual(t["cache_creation_5m"], 1000)  # fallback: all treated as 5m write
        self.assertEqual(t["cache_creation_1h"], 0)

    def test_assistant_without_usage_marked(self):
        path = write_jsonl([{"type": "assistant", "message": {"model": "x", "content": []}}])
        t = az.load_turns(path)[0]
        self.assertFalse(t["usage_present"])
        self.assertEqual(t["input_tokens"], 0)

    def test_non_assistant_lines_ignored(self):
        path = write_jsonl([
            {"type": "user", "message": {"content": "hi"}},
            asst("claude-sonnet-4-6", {"input_tokens": 1, "cache_creation_input_tokens": 0,
                                       "cache_read_input_tokens": 0, "output_tokens": 1,
                                       "service_tier": "standard"}),
        ])
        turns = az.load_turns(path)
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0]["index"], 0)

    def test_duplicate_id_identical_usage_still_counts_once(self):
        # claude-opus-5-style: every line for a message id carries the SAME usage.
        usage = {"input_tokens": 2, "cache_creation_input_tokens": 478,
                  "cache_read_input_tokens": 275384, "output_tokens": 1705,
                  "service_tier": "standard",
                  "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 478}}
        rows = [{"type": "assistant", "message": {"id": "m1", "model": "claude-opus-5",
                                                   "content": [], "usage": usage}} for _ in range(3)]
        path = write_jsonl(rows)
        turns = az.load_turns(path)
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0]["output_tokens"], 1705)
        self.assertEqual(turns[0]["cache_read_input_tokens"], 275384)

    def test_duplicate_id_incremental_usage_takes_final_max(self):
        # claude-sonnet-5-style: output_tokens grows across lines sharing one id;
        # input/cache stay constant. The true billed total is the LAST line's value,
        # not the first. See load_turns() docstring re: 2026-08-04 weekly-brief-sonnet.
        def line(output_tokens):
            return {"type": "assistant", "message": {"id": "m1", "model": "claude-sonnet-5", "content": [],
                    "usage": {"input_tokens": 2, "cache_creation_input_tokens": 13525,
                              "cache_read_input_tokens": 95594, "output_tokens": output_tokens,
                              "service_tier": "standard",
                              "cache_creation": {"ephemeral_5m_input_tokens": 13525,
                                                  "ephemeral_1h_input_tokens": 0}}}}
        path = write_jsonl([line(3), line(3), line(7372)])
        turns = az.load_turns(path)
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0]["output_tokens"], 7372)
        self.assertEqual(turns[0]["cache_read_input_tokens"], 95594)
        self.assertEqual(turns[0]["cache_creation_5m"], 13525)


PRICING = {
    "default_model": "claude-sonnet-4-6",
    "models": {
        "claude-sonnet-4-6": {"in": 3.0, "out": 15.0},
        "claude-opus-4-8": {"in": 15.0, "out": 75.0},
    },
    "cache": {"write_5m_mult": 1.25, "write_1h_mult": 2.00, "read_mult": 0.10},
}


def turn(**kw):
    base = {"index": 0, "model": "claude-sonnet-4-6", "service_tier": "standard",
            "usage_present": True, "input_tokens": 0, "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0, "output_tokens": 0, "cache_creation_5m": 0,
            "cache_creation_1h": 0, "cache_breakdown_present": True}
    base.update(kw)
    return base


class TestCostOfTurn(unittest.TestCase):
    def test_plain_io(self):
        c = az.cost_of_turn(turn(input_tokens=1_000_000, output_tokens=1_000_000), PRICING)
        self.assertAlmostEqual(c, 3.0 + 15.0, places=6)

    def test_5m_and_1h_cache_writes(self):
        c = az.cost_of_turn(turn(cache_creation_5m=1_000_000, cache_creation_1h=1_000_000), PRICING)
        self.assertAlmostEqual(c, 3.0 * 1.25 + 3.0 * 2.00, places=6)

    def test_cache_read(self):
        c = az.cost_of_turn(turn(cache_read_input_tokens=1_000_000), PRICING)
        self.assertAlmostEqual(c, 3.0 * 0.10, places=6)

    def test_unknown_model_uses_default(self):
        c = az.cost_of_turn(turn(model="mystery", input_tokens=1_000_000), PRICING)
        self.assertAlmostEqual(c, 3.0, places=6)

    def test_no_usage_is_zero(self):
        self.assertEqual(az.cost_of_turn(turn(usage_present=False, input_tokens=999), PRICING), 0.0)


class TestDetectSkillLoads(unittest.TestCase):
    def _session(self):
        return [
            {"type": "assistant", "message": {"model": "claude-sonnet-4-6", "usage": {"output_tokens": 1},
                "content": [{"type": "tool_use", "id": "toolu_A", "name": "Skill",
                             "input": {"skill": "ai-sales-coach"}}]}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "toolu_A", "content": "Launching skill: ai-sales-coach"}]}},
            {"type": "user", "message": {"content": "BODY OF THE SALES COACH SKILL " * 10}},
            {"type": "assistant", "message": {"model": "claude-sonnet-4-6",
                "usage": {"cache_creation_input_tokens": 3180}, "content": []}},
        ]

    def test_detects_skill_name_and_call_turn(self):
        path = write_jsonl(self._session())
        loads = az.detect_skill_loads(path)
        self.assertEqual(len(loads), 1)
        self.assertEqual(loads[0]["skill_name"], "ai-sales-coach")
        self.assertEqual(loads[0]["call_turn"], 0)

    def test_captures_injected_body_text(self):
        path = write_jsonl(self._session())
        loads = az.detect_skill_loads(path)
        self.assertIn("BODY OF THE SALES COACH SKILL", loads[0]["injected_text"])
        self.assertNotIn("Launching skill", loads[0]["injected_text"] or "")

    def test_no_body_yields_none(self):
        path = write_jsonl([
            {"type": "assistant", "message": {"model": "m", "usage": {"output_tokens": 1},
                "content": [{"type": "tool_use", "id": "toolu_Z", "name": "Skill",
                             "input": {"skill": "lonely"}}]}},
        ])
        loads = az.detect_skill_loads(path)
        self.assertEqual(loads[0]["skill_name"], "lonely")
        self.assertIsNone(loads[0]["injected_text"])


class TestSplitLoad(unittest.TestCase):
    def test_isolated_load_is_billed(self):
        co = [{"skill_name": "solo", "injected_text": "anything"}]
        out = az.split_load(co, billed_tokens=3180, counter=lambda t: 999)
        self.assertEqual(out["solo"], (3180, "billed"))

    def test_co_load_tokenizer_split(self):
        co = [{"skill_name": "a", "injected_text": "aa"}, {"skill_name": "b", "injected_text": "bb"}]
        counter = lambda t: 300 if t == "aa" else 100
        out = az.split_load(co, billed_tokens=4000, counter=counter)
        self.assertEqual(out["a"], (3000, "tokenizer-split"))
        self.assertEqual(out["b"], (1000, "tokenizer-split"))

    def test_co_load_degrades_to_len_split_when_counter_none(self):
        co = [{"skill_name": "a", "injected_text": "xx"},
              {"skill_name": "b", "injected_text": "xxxxxx"}]
        out = az.split_load(co, billed_tokens=800, counter=lambda t: None)
        self.assertEqual(out["a"], (200, "len-split"))
        self.assertEqual(out["b"], (600, "len-split"))

    def test_co_load_missing_text_degrades(self):
        co = [{"skill_name": "a", "injected_text": None}, {"skill_name": "b", "injected_text": "xx"}]
        out = az.split_load(co, billed_tokens=300, counter=lambda t: 50)
        self.assertEqual(out["a"][1], "len-split")
        self.assertEqual(out["b"][1], "len-split")


class TestAmortize(unittest.TestCase):
    def test_resident_skill_billed_its_size_per_reread_turn(self):
        turns = [
            turn(index=0, cache_creation_input_tokens=1000, cache_read_input_tokens=0),
            turn(index=1, cache_read_input_tokens=5000),
            turn(index=2, cache_read_input_tokens=5000),
        ]
        loads_by_turn = {0: {"s": 1000}}
        out = az.amortize(turns, loads_by_turn)
        self.assertEqual(out["s"], 2000)

    def test_zero_cache_read_turn_contributes_nothing(self):
        turns = [
            turn(index=0, cache_creation_input_tokens=1000, cache_read_input_tokens=0),
            turn(index=1, cache_read_input_tokens=0),
        ]
        out = az.amortize(turns, {0: {"s": 1000}})
        self.assertEqual(out["s"], 0)

    def test_two_resident_skills_each_get_their_size(self):
        turns = [
            turn(index=0, cache_creation_input_tokens=3000, cache_read_input_tokens=0),
            turn(index=1, cache_read_input_tokens=10000),
        ]
        out = az.amortize(turns, {0: {"a": 1000, "b": 2000}})
        self.assertEqual(out["a"], 1000)
        self.assertEqual(out["b"], 2000)


class TestAttributeSkills(unittest.TestCase):
    def test_single_skill_load_and_amortize(self):
        turns = [
            turn(index=0, output_tokens=5),
            turn(index=1, cache_creation_5m=1000, cache_creation_input_tokens=1000),
            turn(index=2, cache_read_input_tokens=4000),
        ]
        loads = [{"skill_name": "coach", "call_turn": 0, "injected_text": "body"}]
        out = az.attribute_skills(turns, loads, counter=lambda t: 1000, pricing=PRICING)
        row = {r["name"]: r for r in out}["coach"]
        self.assertEqual(row["load_tokens"], 1000)
        self.assertEqual(row["load_label"], "billed")
        self.assertAlmostEqual(row["load_cost"], 1000 * 3e-6 * 1.25, places=9)
        self.assertEqual(row["amortized_tokens"], 1000)
        self.assertAlmostEqual(row["amortized_cost"], 1000 * 3e-6 * 0.10, places=9)
        self.assertAlmostEqual(row["total_cost"], row["load_cost"] + row["amortized_cost"], places=12)

    def test_unattributed_when_no_billing_turn(self):
        turns = [turn(index=0, output_tokens=1)]
        loads = [{"skill_name": "tail", "call_turn": 0, "injected_text": None}]
        out = az.attribute_skills(turns, loads, counter=lambda t: None, pricing=PRICING)
        row = {r["name"]: r for r in out}["tail"]
        self.assertEqual(row["load_label"], "unattributed")
        self.assertEqual(row["load_tokens"], 0)


class TestDiff(unittest.TestCase):
    def test_skillset_hash_order_independent(self):
        self.assertEqual(az.skillset_hash(["b", "a"]), az.skillset_hash(["a", "b"]))
        self.assertNotEqual(az.skillset_hash(["a"]), az.skillset_hash(["a", "b"]))

    def test_diff_computes_per_skill_deltas(self):
        prev = {"skills": [{"name": "x", "total_cost": 0.010, "load_tokens": 1000,
                            "amortized_tokens": 500}]}
        cur = {"skills": [{"name": "x", "total_cost": 0.015, "load_tokens": 1200,
                           "amortized_tokens": 700}]}
        d = az.diff_snapshots(cur, prev)
        self.assertAlmostEqual(d["x"]["d_cost"], 0.005, places=9)
        self.assertEqual(d["x"]["d_load_tokens"], 200)
        self.assertEqual(d["x"]["d_amortized_tokens"], 200)

    def test_diff_handles_new_skill(self):
        d = az.diff_snapshots({"skills": [{"name": "new", "total_cost": 0.02,
                                           "load_tokens": 10, "amortized_tokens": 0}]},
                              {"skills": []})
        self.assertEqual(d["new"]["d_load_tokens"], 10)
        self.assertTrue(d["new"]["is_new"])

    def test_diff_none_previous(self):
        self.assertEqual(az.diff_snapshots({"skills": []}, None), {})


class TestBuildReport(unittest.TestCase):
    def test_report_totals_and_determinism(self):
        path = write_jsonl([
            {"type": "assistant", "message": {"model": "claude-sonnet-4-6", "usage": {
                "input_tokens": 10, "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 0,
                "output_tokens": 50, "service_tier": "standard",
                "cache_creation": {"ephemeral_5m_input_tokens": 1000, "ephemeral_1h_input_tokens": 0}},
                "content": [{"type": "tool_use", "id": "t1", "name": "Skill", "input": {"skill": "coach"}}]}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "Launching skill: coach"}]}},
            {"type": "user", "message": {"content": "coach body text " * 20}},
            {"type": "assistant", "message": {"model": "claude-sonnet-4-6", "usage": {
                "input_tokens": 5, "cache_creation_input_tokens": 2000, "cache_read_input_tokens": 0,
                "output_tokens": 30, "service_tier": "standard",
                "cache_creation": {"ephemeral_5m_input_tokens": 2000, "ephemeral_1h_input_tokens": 0}},
                "content": []}},
            {"type": "assistant", "message": {"model": "claude-sonnet-4-6", "usage": {
                "input_tokens": 2, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 3000,
                "output_tokens": 10, "service_tier": "standard"}, "content": []}},
        ])
        counter = lambda t: 2000
        r1 = az.build_report(path, PRICING, None, counter)
        r2 = az.build_report(path, PRICING, None, counter)
        r1.pop("generated"); r2.pop("generated")
        self.assertEqual(json.dumps(r1, sort_keys=True), json.dumps(r2, sort_keys=True))
        self.assertEqual(r1["totals"]["turns"], 3)
        self.assertGreater(r1["totals"]["cost_usd"], 0)
        self.assertTrue(any(s["name"] == "coach" for s in r1["skills"]))
        self.assertEqual(len(r1["per_turn_cost"]), 3)

    def test_report_carries_skillset_hash(self):
        path = write_jsonl([{"type": "assistant", "message": {"model": "claude-sonnet-4-6",
            "usage": {"output_tokens": 1, "service_tier": "standard"}, "content": []}}])
        r = az.build_report(path, PRICING, None, lambda t: None)
        self.assertIn("skillset_hash", r)


class TestRenderHtml(unittest.TestCase):
    TEMPLATE = ("<html><body>"
                "<span id='tok'>{{TOTAL_TOKENS}}</span>"
                "<span id='cost'>{{TOTAL_COST}}</span>"
                "<span id='rates'>{{RATES_AS_OF}}</span>"
                "<table>{{SKILL_ROWS}}</table>"
                "<div id='flags'>{{FLAGS}}</div>"
                "<div id='spark'>{{SPARKLINE}}</div>"
                "</body></html>")

    def test_injects_numbers_and_rows(self):
        report = {
            "totals": {"tokens": 184320, "cost_usd": 0.61, "turns": 3,
                       "cache_read_tokens": 142000, "cache_savings_usd": 0.38},
            "rates_as_of": "2026-05-29",
            "model_mix": {"claude-sonnet-4-6": 3},
            "skills": [{"name": "coach", "load_tokens": 3180, "load_cost": 0.012, "load_label": "billed",
                        "amortized_tokens": 41000, "amortized_cost": 0.013, "total_cost": 0.025}],
            "per_turn_cost": [0.2, 0.3, 0.11],
            "flags": ["test flag"],
            "diff": {"coach": {"d_cost": 0.005, "d_load_tokens": 100,
                               "d_amortized_tokens": 50, "is_new": False}},
        }
        html = az.render_html(report, self.TEMPLATE)
        self.assertIn("184,320", html)
        self.assertIn("0.61", html)
        self.assertIn("2026-05-29", html)
        self.assertIn("coach", html)
        self.assertIn("billed", html)
        self.assertIn("test flag", html)
        self.assertNotIn("{{", html)

    def test_no_skills_renders_placeholder_row(self):
        report = {"totals": {"tokens": 0, "cost_usd": 0, "turns": 0, "cache_read_tokens": 0,
                             "cache_savings_usd": 0}, "rates_as_of": "x", "model_mix": {},
                  "skills": [], "per_turn_cost": [], "flags": [], "diff": {}}
        html = az.render_html(report, self.TEMPLATE)
        self.assertNotIn("{{", html)
        self.assertIn("no skills", html.lower())


if __name__ == "__main__":
    unittest.main()
