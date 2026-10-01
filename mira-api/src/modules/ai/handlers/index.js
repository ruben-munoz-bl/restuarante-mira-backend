const catalog = require("./catalog");
const points = require("./points");
const reservations = require("./reservations");
const social = require("./social");
const user = require("./user");
const admin = require("./admin");

module.exports = { ...catalog, ...points, ...reservations, ...social, ...user, ...admin };