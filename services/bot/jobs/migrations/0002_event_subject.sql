ALTER TABLE events ADD COLUMN subject TEXT;
UPDATE events SET subject = substr(note, 1, instr(note, CASE WHEN kind = 'rejected' THEN ':' ELSE ' ' END) - 1)
WHERE subject IS NULL AND kind IN ('rejected', 'claim_expired')
  AND instr(note, CASE WHEN kind = 'rejected' THEN ':' ELSE ' ' END) > 1;
CREATE INDEX IF NOT EXISTS events_subject ON events (subject, kind);
CREATE INDEX IF NOT EXISTS events_kind_actor ON events (kind, actor);
