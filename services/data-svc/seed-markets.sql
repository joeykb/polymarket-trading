-- TempEdge Market Registry — Seed Data
-- Run against the data-svc SQLite database to populate default markets.
-- Use: sqlite3 output/tempedge.db < services/data-svc/seed-markets.sql

INSERT OR IGNORE INTO markets (id, name, slug_template, unit, station_lat, station_lon, station_name, timezone) VALUES
  ('nyc',         'NYC Temperature',        'highest-temperature-in-nyc-on-{date}',         'F', 40.7769,  -73.874,   'KLGA',  'America/New_York'),
  ('london',      'London Temperature',      'highest-temperature-in-london-on-{date}',      'C', 51.4706,  -0.4619,   'EGLL',  'Europe/London'),
  ('wellington',  'Wellington Temperature',  'highest-temperature-in-wellington-on-{date}',  'C', -41.3272, 174.8050,  'NZWN',  'Pacific/Auckland'),
  ('tokyo',       'Tokyo Temperature',       'highest-temperature-in-tokyo-on-{date}',       'C', 35.5533,  139.7811,  'RJTT',  'Asia/Tokyo'),
  ('sydney',      'Sydney Temperature',      'highest-temperature-in-sydney-on-{date}',      'C', -33.9465, 151.1770,  'YSSY',  'Australia/Sydney'),
  ('miami',       'Miami Temperature',       'highest-temperature-in-miami-on-{date}',       'F', 25.7957,  -80.2870,  'KMIA',  'America/New_York'),
  ('chicago',     'Chicago Temperature',     'highest-temperature-in-chicago-on-{date}',     'F', 41.9742,  -87.9073,  'KORD',  'America/Chicago'),
  ('la',          'LA Temperature',          'highest-temperature-in-los-angeles-on-{date}',  'F', 33.9416,  -118.4085, 'KLAX',  'America/Los_Angeles');
