-- ============================================================
-- Audit RLS — Diagnóstico de Row Level Security (RLS)
-- Rodado no Supabase: Dashboard > SQL Editor > New query > cole tudo > Run
-- Apenas LEITURA — sem alterações no banco.
-- ============================================================

-- 1) Verificar quais tabelas públicas têm RLS ativado
SELECT
  schemaname,
  tablename,
  rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- 2) Listar todas as políticas RLS existentes
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
