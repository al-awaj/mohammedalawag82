-- Phase 11: indexes found by the load test on production-like volume (docs/11-test-report.md).

-- Staff booking lists, newest event first, globally and per country.
CREATE INDEX bookings_start ON bookings (start_at DESC, id);
CREATE INDEX bookings_country_start ON bookings (country_id, start_at DESC, id);

-- "Available on a date" search: blocks overlapping a day, across all services of a country.
CREATE INDEX calendar_blocks_active_period ON calendar_blocks USING gist (blocked_period) WHERE status = 'active';

-- Default search order (newest published first) within a country.
CREATE INDEX services_published ON services (country_id, published_at DESC, id) WHERE status = 'published';
