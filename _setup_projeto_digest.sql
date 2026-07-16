-- ============================================================
-- FASE 2 · peça 4 — DIGEST DE PROJETOS (modo SOMBRA)
--   Tabela de auditoria: o robô GRAVA aqui o que POSTARIA no grupo,
--   com enviado=false. Em sombra NÃO chama a Evolution.
-- Aplicado via Management API (SQL Editor logado) — fimmjgdwhifsrrbreche.
-- Idempotente.
--
-- REGRA INVIOLÁVEL (Fase 2): o digest só LÊ fin_projetos/docs/eventos e
-- RESUME. NUNCA escreve em fin_projetos, NUNCA muda status, NUNCA fala com
-- cliente. Destino previsto (quando sair da sombra): grupo "Projetos -
-- Diagnóstika" JID 120363407925288367@g.us.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.projeto_digest_log (
  id uuid primary key default gen_random_uuid(),
  gerado_em timestamptz not null default now(),
  conteudo text not null,                 -- o texto plano que seria postado
  resumo jsonb,                           -- contadores (parados/docs/a_receber/prazos) p/ a UI
  destino_jid text not null default '120363407925288367@g.us',
  enviado boolean not null default false, -- SOMBRA: sempre false até ligar o envio real
  enviado_em timestamptz,
  origem text not null default 'digest_sombra'
);
create index if not exists projeto_digest_log_data_ix on public.projeto_digest_log(gerado_em desc);

-- Grants + RLS (padrão team_full_ com is_diagnostika_team(); service_role p/ o robô)
grant select, insert, update, delete on public.projeto_digest_log to authenticated;
grant all on public.projeto_digest_log to service_role;
alter table public.projeto_digest_log enable row level security;
drop policy if exists team_full_projeto_digest_log on public.projeto_digest_log;
create policy team_full_projeto_digest_log on public.projeto_digest_log
  for all to authenticated using (is_diagnostika_team()) with check (is_diagnostika_team());

-- Conferência:
-- select gerado_em, enviado, left(conteudo,80) from public.projeto_digest_log order by gerado_em desc;
