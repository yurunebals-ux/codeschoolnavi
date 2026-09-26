-- コメント掲示板（2026-09-26）。何度実行しても壊れないように IF NOT EXISTS
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page TEXT NOT NULL,          -- 記事の slug、または bbs-xxx（掲示板のスレ）
  no INTEGER NOT NULL,         -- ページ内のレス番号（1から）
  name TEXT NOT NULL,          -- 既定「名無しさん」
  body TEXT NOT NULL,
  uid TEXT NOT NULL,           -- 日替わりID（同じ人の書き込みが分かる。IPそのものではない）
  ip_hash TEXT NOT NULL,       -- 連投制限用。IPは保存せず、ソルト付きハッシュだけ
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',  -- visible / hidden（通報・管理で非表示）
  reports INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_page ON comments(page, id);
CREATE INDEX IF NOT EXISTS idx_comments_ip ON comments(ip_hash, created_at);
CREATE TABLE IF NOT EXISTS reports (
  comment_id INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (comment_id, ip_hash)
);
-- ニュース記事の「歓迎派／慎重派」ワンタップ投票（2026-09-26）。1人1ページ1票（選び直しは上書き）
CREATE TABLE IF NOT EXISTS votes (
  page TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  choice TEXT NOT NULL,        -- a（歓迎派）/ b（慎重派）
  created_at TEXT NOT NULL,
  PRIMARY KEY (page, ip_hash)
);
CREATE INDEX IF NOT EXISTS idx_votes_ip ON votes(ip_hash, created_at);
