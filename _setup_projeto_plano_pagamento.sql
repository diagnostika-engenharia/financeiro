-- ============================================================
-- PLANO DE PAGAMENTO DO PROJETO + INTEGRAÇÃO COM CONTAS A RECEBER
-- Aplicado 17/07/2026 (via pooler — ver reference_supabase_db_migration).
-- Aditivo e idempotente.
--
-- REGRA COMERCIAL (definida pelo Rogério em 17/07/2026):
--   - A condição VARIA POR CONTRATO (configurável por projeto).
--   - Padrão sugerido: 30% de entrada + 70% na entrega (o Claudemir ajusta).
--   - A ENTRADA vence NO ACEITE DA PROPOSTA (imediato, mesmo dia — sem prazo de X dias).
--
-- POR QUE ISTO IMPORTA (decisão de arquitetura):
--   Projetos era uma ILHA: sabia QUANTO faltava, mas não QUANDO entrava, e não
--   aparecia no Dashboard / fluxo de caixa / DRE / conciliação / NFS-e.
--   Em vez de reconstruir fluxo de caixa dentro de Projetos, o projeto passa a
--   GERAR contas a receber (fin_contas_receber já tem vencimento, status,
--   conciliação, DRE e NFS-e). Assim tudo isso funciona de graça.
-- ============================================================

-- Plano de pagamento no projeto
alter table public.fin_projetos add column if not exists data_aceite date;
alter table public.fin_projetos add column if not exists saldo_parcelas integer not null default 1;
alter table public.fin_projetos add column if not exists saldo_primeiro_venc date;

comment on column public.fin_projetos.data_aceite is
  'Aceite da proposta = vencimento da ENTRADA (imediato, mesmo dia).';
comment on column public.fin_projetos.saldo_parcelas is
  'Em quantas parcelas o saldo (100% - entrada) será cobrado. 1 = saldo único (padrão: na entrega).';
comment on column public.fin_projetos.saldo_primeiro_venc is
  'Vencimento da 1ª parcela do saldo (as demais, mensais). Null = "na entrega", a definir.';

-- Vínculo Projeto -> Contas a Receber
alter table public.fin_contas_receber
  add column if not exists projeto_id uuid references public.fin_projetos(id) on delete set null;
create index if not exists fin_contas_receber_projeto_ix on public.fin_contas_receber(projeto_id);
comment on column public.fin_contas_receber.projeto_id is
  'Parcela gerada a partir de um projeto (entrada/saldo). Liga Projetos ao fluxo de caixa.';

-- Conferência:
-- select c.nome, p.codigo, p.receita_total_centavos/100.0 total, p.entrada_percentual,
--        p.data_aceite, p.saldo_parcelas, p.saldo_primeiro_venc,
--        (select count(*) from fin_contas_receber r where r.projeto_id = p.id) parcelas_geradas
--   from fin_projetos p join fin_projeto_clientes c on c.id=p.cliente_id order by c.nome;
