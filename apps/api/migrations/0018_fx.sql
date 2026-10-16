-- Currency conversion on received payments (clause 11): when money arrives in another currency than the booking's,
-- the original amount and currency, the rate with its date and source, the converted amount, the actual conversion
-- fee and the exchange difference are stored with the payment. Later rate changes never touch these values.
ALTER TABLE payments
  ADD COLUMN received_currency   char(3) REFERENCES currencies(code),
  ADD COLUMN received_amount     numeric(20,4) CHECK (received_amount > 0),
  ADD COLUMN fx_rate             numeric(24,10) CHECK (fx_rate > 0),
  ADD COLUMN fx_rate_at          timestamptz,
  ADD COLUMN fx_rate_source      text,
  ADD COLUMN fx_rate_id          uuid REFERENCES exchange_rates(id),
  ADD COLUMN converted_amount    numeric(20,4),
  ADD COLUMN fx_conversion_fee   numeric(20,4) NOT NULL DEFAULT 0 CHECK (fx_conversion_fee >= 0),
  ADD COLUMN fx_difference       numeric(20,4) NOT NULL DEFAULT 0,
  ADD CONSTRAINT payments_fx_complete CHECK (received_currency IS NULL OR (received_amount IS NOT NULL AND fx_rate IS NOT NULL AND fx_rate_at IS NOT NULL AND fx_rate_source IS NOT NULL AND converted_amount IS NOT NULL));

-- Once recorded the conversion is history: it cannot be rewritten.
CREATE OR REPLACE FUNCTION payments_fx_frozen() RETURNS trigger AS $$
BEGIN
  IF OLD.received_currency IS NOT NULL AND
     (NEW.received_currency, NEW.received_amount, NEW.fx_rate, NEW.fx_rate_at, NEW.fx_rate_source, NEW.converted_amount, NEW.fx_conversion_fee, NEW.fx_difference)
       IS DISTINCT FROM
     (OLD.received_currency, OLD.received_amount, OLD.fx_rate, OLD.fx_rate_at, OLD.fx_rate_source, OLD.converted_amount, OLD.fx_conversion_fee, OLD.fx_difference) THEN
    RAISE EXCEPTION 'payment % currency conversion is immutable', OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payments_fx_frozen BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION payments_fx_frozen();
