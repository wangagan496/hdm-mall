-- 记录订单创建与付款时的 audit_log 因果序锚点（幂等建表与触发器，兼容历史 v30 库无缝升级且不伪造旧单锚点）
CREATE TABLE IF NOT EXISTS order_audit_anchors (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  created_audit_seq INTEGER CHECK(created_audit_seq IS NULL OR (typeof(created_audit_seq)='integer' AND created_audit_seq>=0)),
  paid_audit_seq INTEGER CHECK(paid_audit_seq IS NULL OR (typeof(paid_audit_seq)='integer' AND paid_audit_seq>=0))
);
CREATE TRIGGER IF NOT EXISTS orders_anchor_insert AFTER INSERT ON orders
BEGIN
  INSERT OR REPLACE INTO order_audit_anchors(order_id, created_audit_seq, paid_audit_seq)
  VALUES(
    NEW.id,
    COALESCE((SELECT MAX(id) FROM audit_log), 0),
    CASE WHEN NEW.paid_at IS NOT NULL THEN COALESCE((SELECT MAX(id) FROM audit_log), 0) ELSE NULL END
  );
END;
CREATE TRIGGER IF NOT EXISTS orders_anchor_paid AFTER UPDATE OF paid_at ON orders
WHEN OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL
BEGIN
  INSERT INTO order_audit_anchors(order_id, created_audit_seq, paid_audit_seq)
  VALUES(
    NEW.id,
    NULL,
    COALESCE((SELECT MAX(id) FROM audit_log), 0)
  )
  ON CONFLICT(order_id) DO UPDATE SET
    paid_audit_seq = COALESCE((SELECT MAX(id) FROM audit_log), 0);
END;
