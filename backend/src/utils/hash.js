const bcrypt = require("bcryptjs");

const SALT_ROUNDS = 10;

module.exports = {
  hashPassword: (plain) => bcrypt.hash(plain, SALT_ROUNDS),
  comparePassword: (plain, hash) => bcrypt.compare(plain, hash),
};
