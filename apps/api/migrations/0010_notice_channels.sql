-- Reminder rules choose their channel (clause 48: customisable by channel). 'auto' = SMS when the
-- customer has a phone, otherwise email; a channel without an address for the customer falls back.
ALTER TABLE reminder_rules ADD COLUMN channel text NOT NULL DEFAULT 'auto' CHECK (channel IN ('auto', 'sms', 'email', 'whatsapp'));
