ALTER TABLE products ADD COLUMN name_normalized text NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN name_tokens text NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN code_normalized text NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN ean_normalized text NOT NULL DEFAULT '';
CREATE OR REPLACE FUNCTION neptun_product_search_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE value text;
BEGIN
  value := concat_ws(' ', NEW.name, NEW.brand, NEW.model, NEW.code, NEW.ean, NEW.category, NEW.subcategory, NEW.category_path, NEW.description, NEW.specs::text);
  NEW.search_text := neptun_normalize(value);
  NEW.search_tokens := regexp_replace(lower(unaccent(value)), '[^a-z0-9]+', ' ', 'g');
  NEW.name_normalized := neptun_normalize(NEW.name);
  NEW.name_tokens := regexp_replace(lower(unaccent(concat_ws(' ',NEW.name,NEW.brand,NEW.model))), '[^a-z0-9]+', ' ', 'g');
  NEW.code_normalized := neptun_normalize(NEW.code);
  NEW.ean_normalized := neptun_normalize(NEW.ean);
  RETURN NEW;
END;
$$;
UPDATE products SET name=name;
CREATE INDEX products_name_trgm_idx ON products USING gin(name_tokens gin_trgm_ops);
CREATE INDEX products_code_normalized_idx ON products(organization_id,code_normalized text_pattern_ops);
CREATE INDEX products_ean_normalized_idx ON products(organization_id,ean_normalized) WHERE ean_normalized<>'';
