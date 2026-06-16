-- ============================================================
-- Adiciona as colunas que faltam em fin_transacoes_bancarias
-- (a tabela foi criada numa versão antiga sem essas colunas).
-- Rode UMA vez no Supabase: SQL Editor > New query > cole tudo > Run.
-- Idempotente: usa ADD COLUMN IF NOT EXISTS.
--
-- Sem rodar isto o sistema FUNCIONA (o frontend é adaptativo e
-- importa só com as colunas existentes). Rodar isto LIBERA os
-- recursos completos: dedupe por hash, rastro da conciliação
-- (vínculo a contas a receber/pagar) e DRE por competência no robô.
-- ============================================================

alter table public.fin_transacoes_bancarias add column if not exists conta            text;
alter table public.fin_transacoes_bancarias add column if not exists historico        text;
alter table public.fin_transacoes_bancarias add column if not exists hash             text;
alter table public.fin_transacoes_bancarias add column if not exists origem_arquivo   text;
alter table public.fin_transacoes_bancarias add column if not exists competencia      text;
alter table public.fin_transacoes_bancarias add column if not exists conta_receber_id bigint;
alter table public.fin_transacoes_bancarias add column if not exists conta_pagar_id   bigint;

-- Preenche historico a partir de descricao (e vice-versa) para linhas já existentes
update public.fin_transacoes_bancarias set historico = descricao where historico is null and descricao is not null;
update public.fin_transacoes_bancarias set descricao = historico where descricao is null and historico is not null;

-- Preenche competencia a partir da data (AAAA-MM) onde estiver vazia
update public.fin_transacoes_bancarias set competencia = to_char(data,'YYYY-MM') where competencia is null and data is not null;

-- Índice único no hash para dedupe idempotente (só cria onde hash não é nulo)
create unique index if not exists ux_fin_txn_hash
  on public.fin_transacoes_bancarias (hash) where hash is not null;

select 'OK — colunas e índice de fin_transacoes_bancarias atualizados' as resultado;
