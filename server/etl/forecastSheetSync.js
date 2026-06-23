/** @deprecated Use forecastImport — kept for sync engine task name compatibility. */
module.exports = require('./forecastImport');
module.exports.syncForecastSheet = require('./forecastImport').importForecastDaily;
