CREATE TABLE cart_requests (
 user_id TEXT NOT NULL REFERENCES users(id),
 request_key TEXT NOT NULL,
 request_body TEXT NOT NULL CHECK(json_valid(request_body)),
 result TEXT NOT NULL CHECK(json_valid(result)),
 created INTEGER NOT NULL,
 PRIMARY KEY(user_id,request_key)
);
PRAGMA user_version=9;
