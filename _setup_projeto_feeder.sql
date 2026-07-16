-- ============================================================
-- FEEDER do grupo Projetos — idempotência
--   Registra cada mensagem do grupo já processada, para reprocessar
--   sem duplicar. Aplicado via Management API. Idempotente.
--
-- REGRA (Fase 2): o feeder só LÊ o grupo e ESCREVE nos objetos de projeto
-- (fin_projetos/docs/eventos). NUNCA fala com cliente. Todo update automático
-- entra em fin_projeto_eventos com confirmado=false (revisável/reversível).
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.projeto_feeder_processados (
  msg_id text primary key,                 -- id da mensagem no WhatsApp (Evolution)
  processado_em timestamptz not null default now(),
  autor text,                              -- pushName de quem mandou
  texto text,                              -- texto original (auditoria)
  relevante boolean,                       -- a IA achou que era update de projeto?
  n_updates int not null default 0,        -- quantos projetos a msg atualizou
  resultado jsonb                          -- o que a IA extraiu / o que foi aplicado
);
create index if not exists projeto_feeder_proc_data_ix on public.projeto_feeder_processados(processado_em desc);

grant select, insert, update, delete on public.projeto_feeder_processados to authenticated;
grant all on public.projeto_feeder_processados to service_role;
alter table public.projeto_feeder_processados enable row level security;
drop policy if exists team_full_projeto_feeder_processados on public.projeto_feeder_processados;
create policy team_full_projeto_feeder_processados on public.projeto_feeder_processados
  for all to authenticated using (is_diagnostika_team()) with check (is_diagnostika_team());

-- Marca de projeto criado automaticamente pelo feeder (rascunho a revisar):
-- reaproveita fin_projetos.origem_ultimo_update='grupo' + um evento tipo 'nota'
-- confirmado=false. Não precisa de coluna nova.
