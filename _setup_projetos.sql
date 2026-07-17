-- ============================================================
-- MÓDULO DE PROJETOS (FASE 1) — objeto "Projeto" no sistema Diagnóstika
--   fin_projeto_clientes / fin_projetos / fin_projeto_docs / fin_projeto_eventos
-- Aplicado via Management API (SQL Editor logado) — projeto fimmjgdwhifsrrbreche.
-- Idempotente: pode rodar de novo (seed usa uuids fixos + ON CONFLICT DO NOTHING;
-- edições feitas depois no app NÃO são sobrescritas).
--
-- Modelo: CLIENTE (1) ──< PROJETO (N) ──< DOC/CHECKLIST (N)
--                                     └──< EVENTO (timeline/auditoria)
-- Custo/receita realizados vêm da coluna `projeto` (etiqueta livre) já
-- existente em fin_transacoes_bancarias; o vínculo é fin_projetos.etiqueta_extrato.
--
-- ── REGRA DA FASE 2 (feeders/robô — NÃO implementado aqui, schema já preparado) ──
-- Os campos origem_ultimo_update / fin_projeto_eventos.origem / .confirmado e
-- fin_projeto_docs.origem existem para os feeders automáticos da fase 2
-- (extrato→conta, doc→checklist, e-mail/grupo→status) e para o robô de digest.
-- INVIOLÁVEL na fase 2: o robô SÓ AVISA a equipe (grupo Projetos
-- 120363407925288367@g.us), NUNCA envia mensagem a cliente e NUNCA muda status
-- sem confirmação humana (evento entra com confirmado=false até um humano validar).
-- ============================================================

create extension if not exists pgcrypto;

-- ─── 1) Clientes de Projetos (PF/PJ — NÃO são os condomínios de fin_clientes) ───
create table if not exists public.fin_projeto_clientes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  doc text,                       -- CPF ou CNPJ (só dígitos, quando souber)
  telefone text,
  email text,
  obs text,
  criado_em timestamptz not null default now()
);
create unique index if not exists fin_projeto_clientes_nome_uq on public.fin_projeto_clientes(nome);

-- ─── 2) Projetos ───
create table if not exists public.fin_projetos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.fin_projeto_clientes(id) on delete restrict,
  codigo text,                    -- ex.: AH-24, Q-46 L01, AA27/AA28, ZM4, JATOBA
  tipo text not null default 'outro',
    -- averbacao | regularizacao | anexacao | habite_se | alvara_construcao |
    -- ampliacao | infraestrutura | aprovacao_condominio | outro
  descricao text,
  endereco text,
  bairro text,
  cidade text,
  dono_imovel_confirmado boolean not null default false,  -- furo que travou o Doni
  status text not null default 'levantamento'
    check (status in ('levantamento','aguardando_doc','elaboracao','protocolo_prefeitura',
                      'analise','aprovado','finalizado','aguardando_pagamento','entregue')),
  responsavel text not null default 'Claudemir',
  proximo_passo text,
  proximo_passo_prazo date,
  etiqueta_extrato text,          -- casa com fin_transacoes_bancarias.projeto
  receita_total_centavos bigint not null default 0,
  receita_recebida_centavos bigint not null default 0,
  last_movement_at timestamptz not null default now(),  -- base do "parado há X dias"
  origem_ultimo_update text not null default 'manual'   -- manual|extrato|gmail|whatsapp|grupo
    check (origem_ultimo_update in ('manual','extrato','gmail','whatsapp','grupo')),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists fin_projetos_cliente_ix on public.fin_projetos(cliente_id);
create index if not exists fin_projetos_status_ix on public.fin_projetos(status);
create index if not exists fin_projetos_mov_ix on public.fin_projetos(last_movement_at);

create or replace function public.fin_projetos_touch()
returns trigger as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_fin_projetos_touch on public.fin_projetos;
create trigger trg_fin_projetos_touch
  before update on public.fin_projetos
  for each row execute function public.fin_projetos_touch();

-- ─── 3) Checklist de documentos ───
create table if not exists public.fin_projeto_docs (
  id uuid primary key default gen_random_uuid(),
  projeto_id uuid not null references public.fin_projetos(id) on delete cascade,
  item text not null,             -- IPTU / matrícula / contrato / ficha_informativa /
                                  -- imagem_fachada / CNH / DARF / CND / ...
  status text not null default 'pendente' check (status in ('pendente','recebido')),
  pendente_desde date not null default current_date,
  recebido_em timestamptz,
  origem text not null default 'manual'    -- manual|extrato|gmail|whatsapp|grupo
    check (origem in ('manual','extrato','gmail','whatsapp','grupo')),
  criado_em timestamptz not null default now()
);
create index if not exists fin_projeto_docs_proj_ix on public.fin_projeto_docs(projeto_id);

-- ─── 4) Eventos (timeline / auditoria — espinha do digest da fase 2) ───
create table if not exists public.fin_projeto_eventos (
  id uuid primary key default gen_random_uuid(),
  projeto_id uuid not null references public.fin_projetos(id) on delete cascade,
  data timestamptz not null default now(),
  origem text not null default 'manual'    -- manual|extrato|gmail|whatsapp|grupo
    check (origem in ('manual','extrato','gmail','whatsapp','grupo')),
  tipo text not null default 'nota'        -- status_change|doc_recebido|pagamento|custo|nota|prazo
    check (tipo in ('status_change','doc_recebido','pagamento','custo','nota','prazo')),
  descricao text,
  valor_centavos bigint,
  confirmado boolean not null default true, -- fase 2: feeder cria confirmado=false até humano validar
  criado_em timestamptz not null default now()
);
create index if not exists fin_projeto_eventos_proj_ix on public.fin_projeto_eventos(projeto_id, data desc);

-- ─── 5) Grants + RLS (padrão team_full_ com is_diagnostika_team(), como demais fin_) ───
-- Função helper já existe em produção (aplicada 10-11/07/2026). Recriada aqui só por
-- segurança/idempotência (STABLE SECURITY DEFINER; equipe = autenticado não-síndico).
create or replace function public.is_diagnostika_team()
  returns boolean language plpgsql stable security definer
  set search_path to 'public','pg_catalog' set row_security to 'off'
as $fn$
declare uid uuid := auth.uid(); is_sindico boolean;
begin
  if uid is null then return false; end if;
  select exists(select 1 from public.user_condos where user_id=uid and role='sindico') into is_sindico;
  return not is_sindico;
end;
$fn$;

do $$
declare t text;
begin
  foreach t in array array['fin_projeto_clientes','fin_projetos','fin_projeto_docs','fin_projeto_eventos'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists team_full_%I on public.%I', t, t);
    execute format('create policy team_full_%I on public.%I for all to authenticated using (is_diagnostika_team()) with check (is_diagnostika_team())', t, t);
  end loop;
end $$;

-- ============================================================
-- 6) SEED — lista de status do Claudemir (grupo Projetos, 01/07/2026 19:35)
--    + pistas do grupo Financeiro (25–26/06) e contrato Village Matisse.
--    last_movement_at fixado na data real do último sinal de vida de cada projeto,
--    para o indicador "parado há X dias" já nascer verdadeiro.
-- ============================================================

insert into public.fin_projeto_clientes (id, nome, doc, obs) values
  ('c0000001-0000-4000-8000-000000000001','Rodrigo', null,
   'Projeto AH-24; aprovação corre no condomínio (e-mail da Nayara — Diagnóstika)'),
  ('c0000001-0000-4000-8000-000000000002','Lucas', null,
   'Projeto aprovado/finalizado em 01/07/2026; a receber R$ 2.000'),
  ('c0000001-0000-4000-8000-000000000003','Alexandre / Jose', null,
   'Provável pagador no extrato: ALEXANDRE CASSIUS BENDALI GEORGES DA SILVA (PIX R$ 500 em 18/06/2026)'),
  ('c0000001-0000-4000-8000-000000000004','Luis Carlos Felisberto', null,
   'Casal Luis Carlos e Jaqueline; PIX R$ 1.500 em 25/06/2026; averbação Receita Federal (CNO → SERO → DARF → CND)'),
  ('c0000001-0000-4000-8000-000000000005','Erica / Doni', null,
   '1 cliente com 4 projetos (Hortolândia). Pendência histórica: confirmar dono do imóvel'),
  ('c0000001-0000-4000-8000-000000000006','Gisele', null,
   'Par Gisele/Lucas no PIX "Agilidade A35"; desenho com cadista Marcus (finalização 50% paga em 25/06/2026)')
  -- Village Matisse REMOVIDO 16/07/2026: é ASSESSORIA (documento pontual parcelado 12x),
  -- não projeto. Segue como cliente de assessoria em fin_clientes.
on conflict (id) do nothing;

insert into public.fin_projetos
  (id, cliente_id, codigo, tipo, descricao, bairro, cidade, status, proximo_passo,
   receita_total_centavos, receita_recebida_centavos, etiqueta_extrato, last_movement_at, origem_ultimo_update) values
  ('b0000002-0000-4000-8000-000000000001','c0000001-0000-4000-8000-000000000001','AH-24','aprovacao_condominio',
   'Projeto da unidade AH-24 — aprovação corre dentro do condomínio', null, null,
   'analise','Cobrar retorno da aprovação no condomínio (e-mail Nayara — Diagnóstika)', 0, 0, null,
   '2026-07-01T19:35:00-03:00','grupo'),
  ('b0000002-0000-4000-8000-000000000002','c0000001-0000-4000-8000-000000000002',null,'outro',
   'Projeto aprovado (finalizado) em 01/07/2026', null, null,
   'aguardando_pagamento','Cobrar pagamento de R$ 2.000', 200000, 0, null,
   '2026-07-01T19:35:00-03:00','grupo'),
  ('b0000002-0000-4000-8000-000000000003','c0000001-0000-4000-8000-000000000003',null,'habite_se',
   'Habite-se — documentação pendente', null, null,
   'aguardando_doc','Pedir 2ª via da documentação no sistema da prefeitura', 0, 0, null,
   '2026-07-01T19:35:00-03:00','grupo'),
  ('b0000002-0000-4000-8000-000000000004','c0000001-0000-4000-8000-000000000004','JATOBA','regularizacao',
   'Regularização/Ampliação (Jatobá). Depois: averbação INSS/Receita Federal (CNO → SERO → DARF → CND)', null, null,
   'aguardando_doc','Cobrar documentação inicial + imagem da fachada', 0, 0, 'Averbação Luis',
   '2026-07-01T19:35:00-03:00','grupo'),
  ('b0000002-0000-4000-8000-000000000005','c0000001-0000-4000-8000-000000000005','AA27/AA28','averbacao',
   'Averbação dos terrenos; em seguida Regularização (oferecer depois Habite-se + Averbação INSS/Receita Federal)', null, 'Hortolândia',
   'levantamento','Definir documentação e iniciar averbação dos terrenos', 0, 0, null,
   '2026-07-01T19:35:00-03:00','grupo'),
  ('b0000002-0000-4000-8000-000000000006','c0000001-0000-4000-8000-000000000005','Q-46 L01','alvara_construcao',
   'Barracão — Alvará de Construção', 'Nossa Senhora de Fátima', 'Hortolândia',
   'aguardando_doc','Cobrar documentação para o alvará', 0, 0, null,
   '2026-07-01T19:35:00-03:00','grupo'),
  ('b0000002-0000-4000-8000-000000000007','c0000001-0000-4000-8000-000000000005',null,'alvara_construcao',
   'Barracão — Alvará de Construção', 'São Bento', 'Hortolândia',
   'aguardando_doc','Cobrar documentação para o alvará', 0, 0, null,
   '2026-07-01T19:35:00-03:00','grupo'),
  ('b0000002-0000-4000-8000-000000000008','c0000001-0000-4000-8000-000000000005','ZM4','alvara_construcao',
   'Prédio — Alvará de Construção (Lote ZM4)', null, 'Hortolândia',
   'levantamento','Levantar requisitos e documentação do lote ZM4', 0, 0, null,
   '2026-07-01T19:35:00-03:00','grupo'),
  ('b0000002-0000-4000-8000-000000000009','c0000001-0000-4000-8000-000000000006','A35','outro',
   'Projeto (desenho com cadista Marcus) — finalização 50% paga em 25/06/2026', null, null,
   'elaboracao','Receber a finalização do cadista Marcus e validar o desenho', 0, 0, null,
   '2026-06-25T13:52:00-03:00','grupo')
  -- Village Matisse (DK-2025-VM) REMOVIDO 16/07/2026: é ASSESSORIA, não projeto.
on conflict (id) do nothing;

insert into public.fin_projeto_docs (id, projeto_id, item, status, pendente_desde) values
  ('d0000003-0000-4000-8000-000000000001','b0000002-0000-4000-8000-000000000003','2ª via da documentação (sistema prefeitura)','pendente','2026-07-01'),
  ('d0000003-0000-4000-8000-000000000002','b0000002-0000-4000-8000-000000000004','Documentação inicial','pendente','2026-07-01'),
  ('d0000003-0000-4000-8000-000000000003','b0000002-0000-4000-8000-000000000004','Imagem da fachada','pendente','2026-07-01'),
  ('d0000003-0000-4000-8000-000000000004','b0000002-0000-4000-8000-000000000005','Matrícula dos terrenos AA27/AA28','pendente','2026-07-01'),
  ('d0000003-0000-4000-8000-000000000005','b0000002-0000-4000-8000-000000000006','Documentação para alvará (Q-46 L01)','pendente','2026-07-01'),
  ('d0000003-0000-4000-8000-000000000006','b0000002-0000-4000-8000-000000000007','Documentação para alvará (São Bento)','pendente','2026-07-01')
on conflict (id) do nothing;

-- Eventos iniciais: a nota do Claudemir (01/07) como marco de cada projeto ativo.
insert into public.fin_projeto_eventos (id, projeto_id, data, origem, tipo, descricao) values
  ('e0000004-0000-4000-8000-000000000001','b0000002-0000-4000-8000-000000000001','2026-07-01T19:35:00-03:00','grupo','nota','Status do Claudemir: AH-24 aguardando aprovação no condomínio (e-mail Nayara).'),
  ('e0000004-0000-4000-8000-000000000002','b0000002-0000-4000-8000-000000000002','2026-07-01T19:35:00-03:00','grupo','nota','Status do Claudemir: aprovado (finalizado), aguardando pagamento de R$ 2.000.'),
  ('e0000004-0000-4000-8000-000000000003','b0000002-0000-4000-8000-000000000003','2026-07-01T19:35:00-03:00','grupo','nota','Status do Claudemir: Habite-se, pendente documentação (2ª via no sistema da prefeitura).'),
  ('e0000004-0000-4000-8000-000000000004','b0000002-0000-4000-8000-000000000004','2026-07-01T19:35:00-03:00','grupo','nota','Status do Claudemir: Jatobá, regularização/ampliação, aguardando documentação e imagem de fachada.'),
  ('e0000004-0000-4000-8000-000000000005','b0000002-0000-4000-8000-000000000005','2026-07-01T19:35:00-03:00','grupo','nota','Status do Claudemir: AA27/AA28, averbação dos terrenos e depois regularização.'),
  ('e0000004-0000-4000-8000-000000000006','b0000002-0000-4000-8000-000000000006','2026-07-01T19:35:00-03:00','grupo','nota','Status do Claudemir: Q-46 L01, barracão, alvará de construção — aguardando documentação (N.Sra. de Fátima, Hortolândia).'),
  ('e0000004-0000-4000-8000-000000000007','b0000002-0000-4000-8000-000000000007','2026-07-01T19:35:00-03:00','grupo','nota','Status do Claudemir: barracão São Bento, alvará de construção — aguardando documentação (Hortolândia).'),
  ('e0000004-0000-4000-8000-000000000008','b0000002-0000-4000-8000-000000000008','2026-07-01T19:35:00-03:00','grupo','nota','Status do Claudemir: prédio no lote ZM4, alvará de construção.'),
  ('e0000004-0000-4000-8000-000000000009','b0000002-0000-4000-8000-000000000009','2026-06-25T13:52:00-03:00','grupo','pagamento','Finalização 50% do cadista Marcus paga (grupo Financeiro).')
  -- evento do Village Matisse REMOVIDO 16/07/2026 (é assessoria, não projeto).
on conflict (id) do nothing;

-- Conferência:
-- select c.nome, p.codigo, p.tipo, p.status, p.proximo_passo,
--        (current_date - p.last_movement_at::date) as parado_dias
--   from fin_projetos p join fin_projeto_clientes c on c.id=p.cliente_id
--  order by c.nome, p.codigo;
