CREATE TABLE order_cancel_requests (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES orders(id),
 sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>0),
 requested_by TEXT NOT NULL REFERENCES users(id),
 payment_id TEXT NOT NULL REFERENCES payments(id),
 state TEXT NOT NULL CHECK(state IN ('pending','withdrawn','approved','rejected-shipped','auto-approved')),
 created INTEGER NOT NULL,
 deadline_at INTEGER NOT NULL CHECK(deadline_at=created+259200000),
 resolved_at INTEGER,
 resolved_by TEXT REFERENCES users(id),
 reject_reason TEXT,
 refund_id TEXT UNIQUE REFERENCES refunds(id),
 UNIQUE(order_id,sequence),
 CHECK((state='pending' AND resolved_at IS NULL AND resolved_by IS NULL AND reject_reason IS NULL AND refund_id IS NULL)
 OR (state='withdrawn' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolved_by=requested_by AND reject_reason IS NULL AND refund_id IS NULL)
 OR (state='approved' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND reject_reason IS NULL AND refund_id IS NOT NULL)
 OR (state='auto-approved' AND resolved_at IS NOT NULL AND resolved_by IS NULL AND reject_reason IS NULL AND refund_id IS NOT NULL)
 OR (state='rejected-shipped' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND reject_reason IS NOT NULL AND length(trim(reject_reason)) BETWEEN 1 AND 200 AND refund_id IS NULL))
);
CREATE UNIQUE INDEX order_cancel_one_pending ON order_cancel_requests(order_id) WHERE state='pending';
CREATE INDEX order_cancel_due ON order_cancel_requests(state,deadline_at,id);
CREATE TABLE order_cancel_actions (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL REFERENCES orders(id),
 cancel_request_id TEXT NOT NULL REFERENCES order_cancel_requests(id),
 actor_id TEXT REFERENCES users(id),
 action TEXT NOT NULL CHECK(action IN ('request','withdraw','approve','reject-and-ship','auto-approve')),
 request_key TEXT NOT NULL UNIQUE,
 request_body TEXT NOT NULL CHECK(json_valid(request_body)),
 result TEXT NOT NULL CHECK(json_valid(result)),
 created INTEGER NOT NULL,
 CHECK((action='auto-approve' AND actor_id IS NULL AND request_key='auto-approve:'||cancel_request_id)
 OR (action<>'auto-approve' AND actor_id IS NOT NULL))
);
CREATE INDEX order_cancel_actions_request ON order_cancel_actions(cancel_request_id,created,id);
PRAGMA user_version=8;
