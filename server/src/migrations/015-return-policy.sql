ALTER TABLE products ADD COLUMN return_policy TEXT NOT NULL DEFAULT 'standard' CHECK(return_policy IN ('standard','law-excluded','confirm-required'));
ALTER TABLE products ADD COLUMN return_policy_reason TEXT NOT NULL DEFAULT '' CHECK(return_policy_reason IN ('','custom','perishable','digital','periodical','unsealed','activated','near-expiry','defect'));
ALTER TABLE products ADD COLUMN return_policy_note TEXT NOT NULL DEFAULT '' CHECK(
 (return_policy='standard' AND return_policy_reason='' AND return_policy_note='') OR
 (return_policy='law-excluded' AND return_policy_reason IN ('custom','perishable','digital','periodical') AND return_policy_note='') OR
 (return_policy='confirm-required' AND ((return_policy_reason IN ('unsealed','activated','near-expiry') AND return_policy_note='') OR (return_policy_reason='defect' AND length(trim(return_policy_note)) BETWEEN 5 AND 100)))
);
ALTER TABLE order_items ADD COLUMN return_policy TEXT NOT NULL DEFAULT 'standard' CHECK(return_policy IN ('standard','law-excluded','confirm-required'));
ALTER TABLE order_items ADD COLUMN return_policy_reason TEXT NOT NULL DEFAULT '' CHECK(return_policy_reason IN ('','custom','perishable','digital','periodical','unsealed','activated','near-expiry','defect'));
ALTER TABLE order_items ADD COLUMN return_policy_note TEXT NOT NULL DEFAULT '' CHECK(
 (return_policy='standard' AND return_policy_reason='' AND return_policy_note='') OR
 (return_policy='law-excluded' AND return_policy_reason IN ('custom','perishable','digital','periodical') AND return_policy_note='') OR
 (return_policy='confirm-required' AND ((return_policy_reason IN ('unsealed','activated','near-expiry') AND return_policy_note='') OR (return_policy_reason='defect' AND length(trim(return_policy_note)) BETWEEN 5 AND 100)))
);
ALTER TABLE order_items ADD COLUMN return_policy_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(return_policy_confirmed IN (0,1) AND (return_policy_confirmed=0 OR return_policy='confirm-required'));
ALTER TABLE after_sale_items ADD COLUMN condition_declared TEXT CHECK(condition_declared IS NULL OR condition_declared IN ('sealed','unsealed'));
CREATE TRIGGER products_return_policy_revision AFTER UPDATE OF return_policy,return_policy_reason,return_policy_note ON products
WHEN OLD.return_policy<>NEW.return_policy OR OLD.return_policy_reason<>NEW.return_policy_reason OR OLD.return_policy_note<>NEW.return_policy_note
BEGIN UPDATE products SET revision=revision+1 WHERE id=NEW.id; END;
PRAGMA user_version=15;
