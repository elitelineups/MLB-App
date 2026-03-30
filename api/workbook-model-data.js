const workbookModelData = require('../data/workbookModelData.json');

module.exports = function handler(_req, res) {
  return res.status(200).json(workbookModelData);
};
