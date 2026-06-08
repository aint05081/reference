require("dotenv").config();

const handler = require("./api/sync-reference");

const req = {
  method: "POST",
  body: {
    pageId: "35d90573-c94b-80e1-8a32-e330c0f7e8cd",
  },
};

const res = {
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(data) {
    console.log("STATUS:", this.statusCode);
    console.log(JSON.stringify(data, null, 2));
  },
};

handler(req, res);