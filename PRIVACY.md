# Política de Privacidade — Travel Planner API

Última atualização: 2025-11-25

## Quem somos
Travel Planner API (“Serviço”, “nós”) é uma API de demonstração/treinamento acessível em `https://leiame.app`, usada para exercícios de reservas, hotéis, voos e itinerários.

## Dados que coletamos
- Identificadores: matrícula (7 dígitos), nome, e-mail, token de admin (para acesso restrito).
- Dados de uso: logs de requisições (método, caminho, status, horário, matrícula/autenticação usada).
- Dados de operação: clientes, hotéis, voos, compras, bookings, itinerários, avaliações e ofertas criadas/atualizadas/excluídas.
- Dados técnicos: endereço IP e user-agent enviados pelo cliente HTTP.

## Finalidades e bases legais
- Operar a API e permitir exercícios de CRUD e buscas para simulações em aula do professor Gustavo Moreira (execução de contrato/legítimo interesse).
- Segurança, auditoria e prevenção de abuso (legítimo interesse).
- Suporte e depuração técnica (legítimo interesse).

## Compartilhamento
- Infraestrutura e armazenamento em nuvem/contêiner (fornecedores de hospedagem e banco de dados).
- Não vendemos dados e não compartilhamos com terceiros para marketing.

## Retenção
- Dados de negócios (clientes, compras, bookings etc.) são apenas simulados e descartados ao final do período/semestre ou quando o ambiente de aula é redefinido.
- Logs de uso podem ser rotacionados periodicamente; são removidos no reset do ambiente.

## Segurança
- Controle de acesso por token (matrícula ou token de admin).
- TLS em `https://leiame.app`.
- Práticas básicas de segurança em banco de dados e aplicação; este é um ambiente de demonstração, sem garantias de produção.

## Seus direitos
- Acessar, corrigir ou excluir dados que você criou usando sua matrícula/token (quando autenticação permitir).
- Revogar seu próprio conteúdo enviando DELETE onde a API suportar ou solicitando por e-mail.

## Cookies e rastreamento
- A API não usa cookies próprios para autenticação; apenas cabeçalhos HTTP.
- Logs podem registrar IP e user-agent para segurança e auditoria.

## Crianças
- O serviço não se destina a menores de 13 anos e não coleta dados intencionalmente desse público.

## Transferências internacionais
- Dados podem ser processados/armazenados em provedores fora do seu país, dependendo da infraestrutura de hospedagem.

## Alterações
- Podemos atualizar esta política; a data de “Última atualização” será ajustada e a nova versão publicada no repositório/endpoint público.

## Contato
- Dúvidas ou solicitações de privacidade: `gmoreira@puc-rio.br`
