-- ============================================================
-- Setup das tabelas do módulo Financeiro — Diagnóstika
-- Rode UMA vez no Supabase: Dashboard > SQL Editor > New query > cole tudo > Run
-- Idempotente: pode rodar de novo sem quebrar nada.
-- ============================================================

create extension if not exists pgcrypto;

-- 1) Histórico de NFS-e emitidas
create table if not exists public.fin_nfse_emitidas (
  id uuid primary key default gen_random_uuid(),
  condominio_id text,
  nome text,
  tomador_doc text,
  tomador_tipo text,
  tomador_razao text,
  competencia text,
  valor numeric(12,2),
  iss_retido text,
  descricao text,
  parcela int,
  numero_nfse text,
  codigo_verificacao text,
  ambiente text default 'homologacao',
  status text default 'emitida',
  conta_receber_id uuid,
  avulsa boolean default false,
  servico text,
  raw jsonb,
  created_at timestamptz default now()
);

-- 2) Transações bancárias (linhas de extrato)
create table if not exists public.fin_transacoes_bancarias (
  id uuid primary key default gen_random_uuid(),
  conta text,
  data date,
  historico text,
  descricao text,
  contraparte_doc text,
  doc text,
  valor numeric(12,2),
  tipo text,
  categoria text,
  tipo_categoria text,
  status text default 'pendente',
  conta_receber_id uuid,
  conta_pagar_id uuid,
  hash text unique,
  origem_arquivo text,
  competencia text,
  created_at timestamptz default now()
);

-- 3) Auditoria de importações de extrato
create table if not exists public.fin_extratos_import (
  id uuid primary key default gen_random_uuid(),
  arquivo text,
  conta text,
  periodo text,
  total_linhas int default 0,
  total_credito numeric(12,2) default 0,
  total_debito numeric(12,2) default 0,
  status text default 'importado',
  created_at timestamptz default now()
);

-- 4) Regras de classificação de transações
create table if not exists public.fin_regras_classificacao (
  id uuid primary key default gen_random_uuid(),
  padrao text not null,
  categoria text not null,
  tipo_categoria text not null,
  prioridade int default 100,
  ativa boolean default true,
  created_at timestamptz default now()
);

-- ---------- Grants + RLS ----------
do $$
declare t text;
begin
  foreach t in array array['fin_nfse_emitidas','fin_transacoes_bancarias','fin_extratos_import','fin_regras_classificacao']
  loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to anon', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists auth_all_%I on public.%I', t, t);
    execute format('create policy auth_all_%I on public.%I for all to authenticated using (true) with check (true)', t, t);
    execute format('drop policy if exists anon_all_%I on public.%I', t, t);
    execute format('create policy anon_all_%I on public.%I for all to anon using (true) with check (true)', t, t);
  end loop;
end $$;

-- ---------- Seed: regras básicas (Sicoob) ----------
insert into public.fin_regras_classificacao (padrao,categoria,tipo_categoria,prioridade)
select * from (values
  ('PIX RECEB','Recebimento PIX','Receita',50),
  ('PIX EMIT','Pagamento PIX','Despesa',50),
  ('COMP VISA','Cartao/Compras','Despesa',60),
  ('DEB DEVOLU','Devolucao PIX','Despesa',60),
  ('TARIFA','Tarifas bancarias','Despesa',40),
  ('IOF','Impostos/IOF','Despesa',40)
) as v(padrao,categoria,tipo_categoria,prioridade)
where not exists (select 1 from public.fin_regras_classificacao r where r.padrao = v.padrao);

-- Pronto. 4 tabelas + RLS + 6 regras.
select 'OK — tabelas do financeiro criadas' as resultado;
