-- 081: ledger of tags the P1→P2 mirror has copied (or adopted) onto a
-- Parent 2 contact.
--
-- The mirror used to be additive-only, which skewed segment counts: when
-- the office removed a tag from Parent 1, the mirrored copy stayed on
-- Parent 2 forever (bad for email-marketing audiences and tag-gated form
-- visibility, which unions tags across the family). With this ledger the
-- mirror can REMOVE too, while only ever touching tags it manages:
--
--   managed = ledger ∪ (P1 ∩ P2 tags each run)   -- shared tags adopted
--   add     = on P1, missing from P2
--   remove  = managed, on P2, no longer on P1
--
-- Organic P2-only tags (e.g. campaign-engagement tags a GHL workflow put
-- on the co-parent directly) are never in the managed set, so they're
-- never stripped. Tags are stored lowercased.

CREATE TABLE IF NOT EXISTS p2_tag_mirror_ledger (
  school_id      uuid NOT NULL,
  ghl_contact_id text NOT NULL,   -- the Parent 2 contact
  tag            text NOT NULL,   -- lowercased
  mirrored_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, ghl_contact_id, tag)
);
