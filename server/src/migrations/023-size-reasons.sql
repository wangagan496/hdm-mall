ALTER TABLE after_sales ADD COLUMN size_reason TEXT CHECK(size_reason IN ('personal-fit','size-promise-mismatch'));
CREATE INDEX after_sales_size_reason ON after_sales(size_reason) WHERE size_reason IS NOT NULL;
PRAGMA user_version=23;
