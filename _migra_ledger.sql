-- ============================================================
-- Financeiro Diagnóstika — Plano de consistência, etapa 3
-- Migração: trilha de origem/inferência/evidência no livro razão
-- Rodar UMA vez no SQL Editor do Supabase (projeto fimmjgdwhifsrrbreche).
-- Idempotente: pode rodar de novo sem efeito colateral.
-- 17/09/2026
-- ============================================================

-- 1) Origem da regra que classificou a linha e estado da inferência
--    origem_regra: 'sync' | 'app' | 'app_prolabore' | 'parcelamento' | 'inferencia_carro' | 'recibo_grupo' | 'manual'
--    status_inferencia: null (não inferida) | 'sugerida' | 'confirmada' | 'rejeitada'
alter table public.fin_transacoes_bancarias
  add column if not exists origem_regra      text,
  add column if not exists status_inferencia text,
  add column if not exists evidencia_msg_id  text,   -- id da mensagem (mensagens_wa) que comprova a classificação
  add column if not exists evidencia_url     text;   -- link do recibo/arquivo, quando houver

alter table public.fin_livro_caixa_cofre
  add column if not exists origem_regra      text,
  add column if not exists status_inferencia text,
  add column if not exists evidencia_msg_id  text,
  add column if not exists evidencia_url     text;

alter table public.fin_transacoes_bancarias
  drop constraint if exists fin_tx_status_inferencia_chk,
  add  constraint fin_tx_status_inferencia_chk
    check (status_inferencia is null or status_inferencia in ('sugerida','confirmada','rejeitada'));

-- 2) Parcelas persistidas (hoje o app deriva em memória de fin_parcelamentos).
--    Cada parcela vira uma linha própria; o app passa a ler daqui quando existir.
create table if not exists public.fin_parcelas (
  id               bigserial primary key,
  parcelamento_id  bigint not null references public.fin_parcelamentos(id) on delete cascade,
  numero           int    not null,
  competencia      text   not null,              -- 'YYYY-MM' da parcela
  valor            numeric(12,2) not null,       -- em reais
  categoria        text,
  tipo_categoria   text default 'Despesa',
  transacao_id     bigint references public.fin_transacoes_bancarias(id) on delete set null, -- linha do extrato que a quitou
  criado_em        timestamptz default now(),
  unique (parcelamento_id, numero)
);
alter table public.fin_parcelas disable row level security;  -- mesmo padrão de fin_parcelamentos (service_role)

-- 3) Backfill das linhas já existentes
update public.fin_transacoes_bancarias set origem_regra='sync'
  where origem_regra is null and hash like 'sic%';
update public.fin_transacoes_bancarias set origem_regra='app_prolabore', status_inferencia=null
  where origem_regra is null and origem_arquivo='app_prolabore';
update public.fin_transacoes_bancarias set origem_regra='inferencia_carro', status_inferencia='confirmada'
  where origem_regra is null and categoria='Pró-labore (financ. veículo)' and observacao ilike '%confirmado no app%';
update public.fin_transacoes_bancarias set origem_regra='manual'
  where origem_regra is null;
update public.fin_livro_caixa_cofre set origem_regra=case when origem='Automático' then 'app' else 'manual' end
  where origem_regra is null;

-- 4) Índices de apoio
create index if not exists fin_tx_competencia_idx on public.fin_transacoes_bancarias(competencia);
create index if not exists fin_tx_origem_regra_idx on public.fin_transacoes_bancarias(origem_regra);

-- Conferência rápida
select origem_regra, count(*) from public.fin_transacoes_bancarias group by 1 order by 2 desc;
