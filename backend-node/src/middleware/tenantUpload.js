const { runWithTenant } = require('../utils/tenantContext');

// Multipart stream events can complete outside the authentication middleware's ALS scope.
function tenantUpload(parser) {
  return (req, res, next) => parser(req, res, err => {
    if (err) return next(err);
    if (!req.user?.organization?.id) return res.sendStatus(401);
    runWithTenant(req.user.organization.id, next);
  });
}
module.exports = { tenantUpload };
