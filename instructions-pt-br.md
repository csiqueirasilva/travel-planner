# Instruções do exercício (PT-BR)

## Pré-requisitos
- Endereço base: `https://leiame.app`
- Header `Authorization` obrigatório:
  - Para criar/administrar clientes: usar o **token de admin** definido em `config/admin.json` no servidor (ou variável `ADMIN_TOKEN`).
  - Alternativamente, pode-se usar uma matrícula de 7 dígitos como token (ex.: `1234567`) para criar/consultar o próprio cliente.

---

# Exercício 1: Registrar cliente

Objetivo: registrar um cliente e confirmar o cadastro.

Passos:
1) `POST /clients` com corpo, ex.:
   ```json
   { "matricula": "7654321", "name": "Aluno Teste", "email": "aluno.teste@example.com" }
   ```
   Header `Authorization`: admin token ou a própria matrícula.
   Esperado: **201** com objeto do cliente.
2) `GET /clients/7654321` com o mesmo header.
   Esperado: **200** com dados do cliente.

Dicas:
- **401**: header ausente/errado.
- **400**: matrícula não tem 7 dígitos.
- Token admin acessa qualquer matrícula; token de matrícula só acessa a própria.

---

# Exercício 2: Explorar destinos e hotéis

Objetivo: listar destinos e consultar hotéis com filtros.

Passos:
1) `GET /locations` → **200** com cidades/regiões.
2) Escolher uma cidade (ex.: `Rio de Janeiro`), então `GET /hotels?city=Rio de Janeiro` → **200** com hotéis.
3) Filtros opcionais:
   - Preço: `priceMin`, `priceMax`
   - Estrelas: `stars`
   - Amenidades: `amenities=wifi,pool`

Dicas:
- Lista vazia ainda retorna **200**; revise ortografia/filtros se não vier resultado.
- Amenidades devem bater com nomes cadastrados (`wifi`, `pool`, `spa`, `gym`, `breakfast`, etc.).

---

# Exercício 3: Inspecionar detalhes e disponibilidade de hotel

Objetivo: pegar detalhes de um hotel e checar disponibilidade em um intervalo de datas.

Passos:
1) Escolher um `id` de hotel (da lista de hotéis).
2) `GET /hotels/{id}` → **200** com dados, tipos de quarto e avaliações.
3) `GET /hotels/{id}/availability?startDate=2025-12-01&endDate=2025-12-05` → **200** com tipos de quarto, preço e campo `available`.

Dicas:
- **404**: revise o `id` informado.
- Datas são opcionais, mas ajudam a contextualizar o teste.
- Seed não controla reservas reais; a disponibilidade retorna a estrutura com o campo `available`.

---

# Exercício 4: Buscar voos (planes)

Objetivo: procurar voos para uma cidade e inspecionar opções específicas.

Passos:
1) **Buscar voos**  
   - Chamar `GET /planes/search?origin=RIO&destination=SAO&date=2025-12-02` (ajuste origem/destino/data conforme o cenário).  
   - Resultado esperado: **200** com lista de voos.
2) **Inspecionar voos específicos**  
   - Escolher pelo menos dois `id` da lista.  
   - Chamar `GET /planes/{id}` para cada um.  
   - Resultado esperado: **200** com detalhes do voo (código, horários, preço).

Dicas:
- Filtros são opcionais; se vier lista vazia, tente remover/ajustar `date`, `origin`, `destination`.
- IDs vêm da resposta de busca; um `404` indica que o id não existe.

---

# Exercício 5: Conferir ofertas e descontos

Objetivo: consultar promoções vigentes e entender quais recursos estão com desconto.

Passos:
1) **Ver ofertas do dia**  
   - `GET /offers/today` → **200** com lista de promoções válidas hoje.
2) **Filtrar por data específica**  
   - `GET /offers?date=2025-12-01` → **200** com promoções que ainda estão válidas nessa data (ou sem data limite).
3) **Ler cada oferta**  
   - Observar `title`, `description` e `discountPercent`; anotar se a descrição menciona hotel/rota/condição específica.

Dicas:
- Se lista vazia: não há promoções para a data; tente outra data ou remova o filtro.
- `validUntil` pode ser nulo para ofertas sem data de expiração.

---

# Exercício 6: Montar e registrar uma viagem (purchase)

Objetivo: combinar hotel + voo escolhidos e registrar a compra, aplicando desconto manualmente (se houver).

Passos:
1) Escolher hotel (Exercícios 2 e 3) e voo (Exercício 4) e decidir datas de check-in/out.
2) Consultar ofertas (`/offers` ou `/offers/today`) e anotar um desconto aplicável.
3) Registrar a compra:  
   - `POST /purchases` com corpo, ex.:
     ```json
     {
       "clientMatricula": "1234567",
       "hotelId": 1,
       "planeId": 2,
       "checkIn": "2025-12-01",
       "checkOut": "2025-12-05",
       "guests": 2,
       "totalAmount": 1800
     }
     ```
   - Header `Authorization`: token admin ou a matrícula do cliente.
   - Esperado: **201** com `id` da compra. Guardar esse `id` para próximos passos.

Dicas:
- Se o desconto for aplicável, calcule o valor final manualmente e envie em `totalAmount`.
- **401/403**: revise o token (admin pode criar para qualquer matrícula; token de matrícula só pode criar para si).
- **404**: confira `hotelId`/`planeId`.

---

# Exercício 7: Alterar ou cancelar uma compra

Objetivo: praticar atualização e cancelamento de uma compra (booking/purchase).

Passos:
1) Escolher o `purchaseId` retornado no exercício anterior.
2) Alterar datas ou hóspedes:  
   - `PUT /purchases/{purchaseId}` com corpo, ex.:  
     ```json
     {
       "checkIn": "2025-12-02",
       "checkOut": "2025-12-06",
       "guests": 3,
       "totalAmount": 1700
     }
     ```
   - Header `Authorization`: admin token ou a matrícula dona da compra.  
   - Esperado: **200** com a compra atualizada.
3) Cancelar (opcional):  
   - `DELETE /purchases/{purchaseId}` com o mesmo header.  
   - Esperado: **200** com `{ deleted: true }`.

Dicas:
- **401/403**: token não permite alterar compras de outro usuário (exceto admin).
- **404**: ID não existe ou já removido.
- DELETE é idempotente: se chamar de novo, pode retornar 404 caso já tenha sido removido.

---

# Exercício 8: Enviar avaliação de hotel

Objetivo: reforçar POST com dados do usuário (matrícula) e vínculo com o hotel.

Passos:
1) Escolher um `hotelId` já conhecido (dos exercícios anteriores).
2) Enviar avaliação:  
   - `POST /hotels/{hotelId}/reviews` com corpo, ex.:  
     ```json
     { "rating": 4, "comment": "Quarto limpo e boa localização." }
     ```  
   - Header `Authorization`: matrícula do aluno (7 dígitos) ou token admin.  
   - Esperado: **201** com a avaliação criada.
3) Listar avaliações do hotel:  
   - `GET /hotels/{hotelId}/reviews`  
   - Esperado: **200** com a lista incluindo sua avaliação.

Dicas:
- **401**: header ausente/ inválido.
- **404**: hotel não encontrado.
- `rating` é obrigatório; `comment` é opcional.

---

# Exercício 9: Montar um itinerário (multi-segmento)

Objetivo: criar e manipular um itinerário que agrupe múltiplos trechos (hotel, voo, atividades).

Passos:
1) Criar itinerário:  
   - `POST /itineraries` com corpo, ex.:  
     ```json
     { "name": "Viagem de férias", "notes": "Adicionar passeios depois", "clientMatricula": "1234567" }
     ```  
   - Header `Authorization`: token admin ou matrícula do dono.  
   - Esperado: **201** com `id` do itinerário.
2) Vincular reservas (opcional):  
   - Ao criar bookings (`POST /bookings`), enviar `itineraryId` para amarrar hotel/voo ao itinerário.
3) Consultar itinerário:  
   - `GET /itineraries/{id}` → **200** com bookings ligados.
4) Atualizar:  
   - `PUT /itineraries/{id}` com campos como `name` ou `notes`.  
   - Esperado: **200** com dados atualizados.

Dicas:
- **401/403**: apenas o dono ou admin pode ler/alterar.
- **404**: itinerário inexistente.
- Para ver bookings dentro do itinerário, eles precisam ter sido criados com `itineraryId`.
