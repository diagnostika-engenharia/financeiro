-- ============================================================
-- REGRA DE NEGÓCIO: ENTRADA DE 30% ANTES DE COMEÇAR
--   "Todo contrato, antes de começar, precisa pagar 30% do valor."
-- Aditivo em fin_projetos. Idempotente.
--
-- Modelo:
--   receita_total_centavos    = valor contratado
--   entrada_percentual        = % exigido antes de iniciar (default 30)
--   entrada exigida (derivada)= round(receita_total * entrada_percentual/100)
--   entrada paga (derivada)   = receita_recebida >= entrada exigida
--   entrada_paga_em           = quando a entrada foi atingida (carimbado pelo
--                               feeder de pagamento ou manualmente)
--
-- O controle é DERIVADO do dinheiro que entrou (receita_recebida), que por sua
-- vez é alimentado pelo feeder do extrato. Sem valor contratado (=0) não há
-- como cobrar a entrada — por isso o feeder do grupo passa a ler o valor no texto.
-- ============================================================

alter table public.fin_projetos
  add column if not exists entrada_percentual numeric(5,2) not null default 30;

alter table public.fin_projetos
  add column if not exists entrada_paga_em timestamptz;

comment on column public.fin_projetos.entrada_percentual is
  'Percentual do contrato exigido como entrada antes de iniciar (regra padrão: 30%).';
comment on column public.fin_projetos.entrada_paga_em is
  'Quando a entrada exigida foi atingida (null = ainda não). Carimbado pelo feeder de pagamento.';

-- Conferência:
-- select c.nome, p.codigo, p.status,
--        p.receita_total_centavos/100.0 as contratado,
--        p.receita_recebida_centavos/100.0 as recebido,
--        round(p.receita_total_centavos * p.entrada_percentual/100)/100.0 as entrada_exigida,
--        (p.receita_recebida_centavos >= round(p.receita_total_centavos * p.entrada_percentual/100)
--          and p.receita_total_centavos > 0) as entrada_ok,
--        p.entrada_paga_em
--   from fin_projetos p join fin_projeto_clientes c on c.id = p.cliente_id
--  order by c.nome, p.codigo;
