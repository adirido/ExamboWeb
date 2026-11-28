-- Migration 004: Multi-class exam scheduling & dedicated proctor (Guru Pengawas)
ALTER TABLE exam_packages
  ADD COLUMN IF NOT EXISTS proctor_id BIGINT REFERENCES teachers(id) ON DELETE SET NULL;

ALTER TABLE exam_packages
  ADD COLUMN IF NOT EXISTS exam_date TEXT NOT NULL DEFAULT '';

ALTER TABLE exam_packages
  ADD COLUMN IF NOT EXISTS kkm INTEGER NOT NULL DEFAULT 75;

ALTER TABLE exam_packages
  ADD COLUMN IF NOT EXISTS schedule_group TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_exam_packages_proctor_id ON exam_packages(proctor_id);
CREATE INDEX IF NOT EXISTS idx_exam_packages_schedule_group ON exam_packages(schedule_group);
