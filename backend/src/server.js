const app = require("./app");
require("dotenv").config({ quiet: true });

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`CampusHub API listening on http://localhost:${PORT}`);
});
