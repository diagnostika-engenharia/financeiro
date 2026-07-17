-- ============================================================
-- MAPA DE CONTATOS DE PROJETOS (whitelist do feeder 1:1)
-- Aplicado 17/07/2026 (via pooler). Aditivo e idempotente.
--
-- POR QUE EXISTE: as conversas 1:1 (mensagens_wa) já são capturadas, mas
-- misturam TUDO — condomínio, ART, reforma e projeto. O feeder só deve ler
-- quem trata de PROJETO. O número é um link feito por humano, igual à
-- etiqueta do extrato — e foi a etiqueta (não a IA) que resolveu o Lucas.
--
-- ARMADILHA COMPROVADA (17/07): mapear por NOME quebra.
--   • "Erika" (5519995028804) fala de pintar sacada de apartamento -> CONDOMÍNIO,
--     não é a "Erica (Doni)" dos projetos (5519992058702).
--   • Buscar "Alexandre" nos arquivos acha uma reforma no Portal Primavera;
--     "Rodrigo" acha um arquiteto do Menotti; "Doni" acha uma academia.
-- Por isso: mapa por NÚMERO, confirmado por humano. Nunca inferido por nome.
--
-- REGRA: o feeder só LÊ os contatos ativo=true AND confirmado=true.
-- NUNCA responde a cliente/prestador. Updates entram confirmado=false.
-- ============================================================

create extension if not exists pgcrypto;

create table if not exists public.projeto_contatos (
  id uuid primary key default gen_random_uuid(),
  tel text not null unique,                 -- só dígitos, com DDI (ex: 5519992058702)
  nome text not null,                       -- como aparece no WhatsApp
  tipo text not null default 'cliente'
    check (tipo in ('cliente','prestador','parceiro')),
  cliente_id uuid references public.fin_projeto_clientes(id) on delete set null,
  ativo boolean not null default true,      -- whitelist: feeder só lê se ativo
  confirmado boolean not null default false,-- humano confirmou quem é
  evidencia text,                           -- por que achamos que é este contato
  obs text,
  criado_em timestamptz not null default now()
);
create index if not exists projeto_contatos_ativo_ix on public.projeto_contatos(ativo, confirmado);

grant select, insert, update, delete on public.projeto_contatos to authenticated;
grant all on public.projeto_contatos to service_role;
alter table public.projeto_contatos enable row level security;
drop policy if exists team_full_projeto_contatos on public.projeto_contatos;
create policy team_full_projeto_contatos on public.projeto_contatos
  for all to authenticated using (is_diagnostika_team()) with check (is_diagnostika_team());

-- ── Seed: contatos identificados pelo CONTEÚDO das conversas (17/07/2026) ──
insert into public.projeto_contatos (tel, nome, tipo, cliente_id, confirmado, evidencia) values
  ('5519992058702','Erica (Doni)','cliente',
    (select id from public.fin_projeto_clientes where nome='Erica / Doni'), true,
    '433 msgs (abr-jul): "anexacao de lotes la dentro da loteadora"; "area total ocupada no terreno 237,23" -> casa com AA27/AA28. NAO confundir com "Erika" 5519995028804 (condominio/sacada).'),
  ('5519974157407','Luis','cliente',
    (select id from public.fin_projeto_clientes where nome='Luis Carlos Felisberto'), true,
    '48 msgs; 16/07 Claudemir: "Fiz o pagamento da ficha informativa" e no extrato ha R$49,72 "Ficha Informativa N09" no mesmo dia -> Jatoba/N-09.'),
  ('5519996497517','Alexandre Cassius','cliente',
    (select id from public.fin_projeto_clientes where nome='Alexandre / Jose'), true,
    '"Estou aguardando sair a 2a das documentacoes" -> casa com o projeto Habite-se (2a via no sistema da prefeitura).'),
  ('5511963788173','Marcus Prado','prestador', null, true,
    'Cadista. "Pode fazer a ART para 270,95m2" / "Amanha o projeto ja esta pronto" -> producao de projeto. Atende varios projetos: o numero diz que e assunto de producao, nao QUAL projeto.')
on conflict (tel) do update set
  nome = excluded.nome, tipo = excluded.tipo,
  cliente_id = coalesce(excluded.cliente_id, public.projeto_contatos.cliente_id),
  evidencia = excluded.evidencia;

-- Conferência:
-- select c.tel, c.nome, c.tipo, cl.nome as cliente, c.ativo, c.confirmado
--   from projeto_contatos c left join fin_projeto_clientes cl on cl.id=c.cliente_id
--  order by c.tipo, c.nome;
