CREATE TABLE evaluation_followups (
 order_id TEXT PRIMARY KEY REFERENCES evaluations(order_id),
 actor_id TEXT NOT NULL REFERENCES users(id),
 content TEXT NOT NULL CHECK(length(trim(content)) BETWEEN 5 AND 300),
 created INTEGER NOT NULL
);
CREATE TRIGGER evaluation_followup_no_update BEFORE UPDATE ON evaluation_followups
 BEGIN SELECT RAISE(ABORT,'Followup cannot be modified'); END;
CREATE TRIGGER evaluation_followup_no_delete BEFORE DELETE ON evaluation_followups
 BEGIN SELECT RAISE(ABORT,'Followup cannot be deleted'); END;

CREATE TABLE evaluation_service_records (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES evaluations(order_id),
 after_sale_id TEXT REFERENCES after_sales(id),
 case_id TEXT NOT NULL CHECK(length(trim(case_id))>0),
 source TEXT NOT NULL CHECK(source IN ('system-case')),
 summary TEXT NOT NULL CHECK(length(trim(summary))>=1),
 created INTEGER NOT NULL
);
CREATE INDEX evaluation_service_records_order ON evaluation_service_records(order_id,created,id);
PRAGMA user_version=27;
