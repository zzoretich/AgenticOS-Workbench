// Unit tests import main-process modules for their pure functions only. In plain Node, require("electron") would try
// to download the Electron binary, so the unit-test bundle gets this empty stand-in instead.
module.exports = {};
