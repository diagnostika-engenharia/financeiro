-- Fix RLS para tabelas desprotegidas — Diagnóstika
-- Identificadas em 2026-06-21 via Supabase Auth > Policies
-- Rode no SQL Editor do Supabase

-- 1) demanda_seq — sequência de demandas (sem RLS, sem policies)
ALTER TABLE public.demanda_seq ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_demanda_seq" ON public.demanda_seq;
CREATE POLICY "auth_all_demanda_seq" ON public.demanda_seq FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 2) fin_extratos_import — auditoria de importação de extrato (sem RLS)
ALTER TABLE public.fin_extratos_import ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_fin_extratos_import" ON public.fin_extratos_import;
CREATE POLICY "auth_all_fin_extratos_import" ON public.fin_extratos_import FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3) manutencao_seq — sequência de manutenções (sem RLS, sem policies)
ALTER TABLE public.manutencao_seq ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth_all_manutencao_seq" ON public.manutencao_seq;
CREATE POLICY "auth_all_manutencao_seq" ON public.manutencao_seq FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 4) rate_limit_attempts — tem RLS mas sem policy (bloqueada por padrão, ok)
-- Não precisa de fix, dados não são retornados via API

SELECT 'OK — RLS ativado em demanda_seq, fin_extratos_import, manutencao_seq' AS resultado;
