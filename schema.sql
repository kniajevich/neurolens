CREATE TABLE IF NOT EXISTS api_tokens (
    token TEXT PRIMARY KEY,
    owner TEXT,
    is_master INTEGER DEFAULT 0,
    daily_limit INTEGER DEFAULT 50,
    requests_today INTEGER DEFAULT 0,
    last_reset_date TEXT
);
