const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function runWithTenant(organizationId, callback) {
  return storage.run(Number(organizationId), callback);
}

function getTenantId() {
  const id = storage.getStore();
  return Number.isInteger(id) && id > 0 ? id : null;
}

module.exports = { runWithTenant, getTenantId };
