'use strict';

const inspector = require('inspector');
class Session extends inspector.Session {
  post(method, params) {
    return new Promise((resolve, reject) => {
      super.post(method, params, (error, result) => error ? reject(error) : resolve(result));
    });
  }
}
module.exports = { ...inspector, Session };
