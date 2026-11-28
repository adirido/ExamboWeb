-- Migrasi Login Email -> NIP / ID Login (fleksibel) & Pembaruan Kredensial Awal
-- Jalankan di Supabase SQL Editor (atau melalui `supabase db push`) sebelum/bersamaan dengan deploy Edge Function `api`.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'teachers' AND column_name = 'email'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'teachers' AND column_name = 'nip'
  ) THEN
    ALTER TABLE public.teachers RENAME COLUMN email TO nip;
  END IF;
END $$;

UPDATE public.teachers
SET
  nip = '252500',
  password_hash = '1054e2e19fc591cd3701f76a97f1aed1:2cf1cd79c51ba17a8e1aec3eb349c7fedb1a45bdb00974dc7f34779bef58d89e39904d1acd03e29da11527d0ca010203e4a7e8373441c759f7eabe38de69f71a'
WHERE LOWER(nip) = 'budi.santoso@examflow.sch.id' OR nip = '252500';

UPDATE public.teachers
SET
  nip = '252501',
  password_hash = '63a19183a71c33ba1c0cc6cb4b70d701:d258024ef1db65df26b3fb5f25771e0bfc2f6891feddb867f4ab62ac456118963aedf831b745575a429240364779de5529b457c7436562dc7d16148a47caff1a'
WHERE LOWER(nip) = 'siti.aminah@examflow.sch.id' OR nip = '252501';
