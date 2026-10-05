// `fs/promises` as the re-hosted HUD sees it: the guarded fs's promises (see fs.cjs).

module.exports = require("./fs.cjs").promises;
