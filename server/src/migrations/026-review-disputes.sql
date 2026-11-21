CREATE TABLE review_disputes (
 review_id TEXT PRIMARY KEY NOT NULL REFERENCES evaluations(public_id),
 merchant_id TEXT NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 200),
 images TEXT NOT NULL CHECK(json_valid(images) AND json_type(images)='array' AND json_array_length(images)<=3),
 status TEXT NOT NULL CHECK(status IN ('registered','under-review','concluded','correction-requested'))
);
CREATE TABLE review_dispute_actions (
 id INTEGER PRIMARY KEY, review_id TEXT NOT NULL REFERENCES review_disputes(review_id),
 kind TEXT NOT NULL CHECK(kind IN ('register','accept','conclude','buyer-correction','merchant-correction')),
 actor_id TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL, created INTEGER NOT NULL,
 original TEXT NOT NULL CHECK(json_valid(original))
);
CREATE INDEX dispute_action_history ON review_dispute_actions(review_id,id);
CREATE UNIQUE INDEX dispute_once ON review_dispute_actions(review_id,kind) WHERE kind IN ('register','buyer-correction','merchant-correction');
CREATE TABLE review_dispute_conclusions (
 action_id INTEGER PRIMARY KEY REFERENCES review_dispute_actions(id),
 kind TEXT NOT NULL CHECK(kind IN ('maintain','hide','correct')),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 200),
 hidden INTEGER NOT NULL CHECK(hidden=(kind='hide'))
);
PRAGMA user_version=26;
