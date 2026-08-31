-- KamDova product taxonomy.
--
-- The product list gains a parent, so the capability map (TEACHER / STUDENT /
-- MARKETPLACE / PARTNERSHIP, each with its features beneath) is a tree in data
-- rather than a shape hard-coded in the client. Renaming a branch, or moving a
-- feature between branches, stays a row change.
ALTER TABLE products ADD COLUMN parent_code TEXT REFERENCES products(code);
ALTER TABLE products ADD COLUMN kind TEXT NOT NULL DEFAULT 'FEATURE'
  CHECK (kind IN ('AREA', 'FEATURE'));
ALTER TABLE products ADD COLUMN icon TEXT;

CREATE INDEX idx_products_parent ON products (parent_code, sort_order);
