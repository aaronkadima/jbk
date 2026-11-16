# JBK — entregas em tempo real

Plataforma web e mobile (PWA instalável) de entregadores com rastreamento animado ao vivo.
Funciona na República Democrática do Congo, no Brasil e nos EUA, em português, francês e inglês.

- **Cliente**: abre direto no mapa, vê os entregadores livres por perto e pede que um deles busque
  um pacote em qualquer loja e leve até onde ele está.
- **Loja**: pede um entregador para levar a compra ao cliente e compartilha um link público de rastreio.
- **Entregador**: cadastra-se indicando o meio de deslocamento (a pé, bicicleta, moto, carro); depois
  de aprovado pelo administrador, fica online, aparece no mapa e recebe ofertas de pedidos próximos.
- **Administrador**: aprova ou recusa cadastros de entregadores.
- **Avisos**: toda mudança de status gera notificação no app, notificação do sistema e, com chaves
  VAPID configuradas, push com o app fechado.

O mapa tem estilo próprio de carta de exploração: pergaminho, traço de tinta, mar com ondas
desenhadas, rota pontilhada até um X vermelho.

## Rodar

```bash
npm install
cp .env.example .env      # opcional em desenvolvimento
npm run dev               # API em :4000, app em http://localhost:5173
```

Sem `DATABASE_URL` o servidor usa um banco em memória (os dados somem ao reiniciar). Com `DEMO=1`
aparecem entregadores simulados perto de quem abre o mapa; eles aceitam pedidos e fazem a entrega,
o que permite ver o fluxo inteiro sem frota real.

Conta de administração em desenvolvimento: telefone `+10000000000`, senha `admin123`
(em produção, `ADMIN_PHONE` e `ADMIN_PASSWORD` são obrigatórios).

```bash
npm test                  # fluxo ponta a ponta: cadastro, aprovação, pedido, aceite, entrega, avisos
E2E_DATABASE_URL=postgres://... npm test   # o mesmo teste contra um PostgreSQL real
```

## Produção

```bash
JWT_SECRET=... ADMIN_PHONE=+243... ADMIN_PASSWORD=... docker compose up --build
```

Um único processo Node entrega a API, os sockets e a PWA compilada na porta 4000. A localização do
navegador e a instalação da PWA exigem **HTTPS**; ponha o serviço atrás de um proxy com TLS
(Render, Railway, Fly.io, Caddy, Nginx). Variáveis em `.env.example`.

Push com o app fechado: gere as chaves com `npx web-push generate-vapid-keys` e preencha
`VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY`.

## Como funciona

```
web/      React + TypeScript + Vite, MapLibre GL, Zustand, Socket.IO client
  src/map/style.ts    estilo "carta de exploração" (camadas e texturas geradas em canvas)
  src/map/mapctl.ts   marcadores animados, rota, pinos
  src/state.ts        estado do app, REST e sockets
  src/ui/             pedido, rastreio, entregador, conta, admin, avisos
server/   Node + Express + Socket.IO + PostgreSQL
  src/hub.ts          entregadores online, salas por célula geográfica, notificações
  src/orders.ts       ciclo do pedido e despacho
  src/api.ts          rotas REST
  src/demo.ts         entregadores simulados
```

**Tempo real.** O mundo é dividido em células de cerca de 5,5 km. Quem olha o mapa entra nas salas
das 25 células ao redor do centro da tela, e cada posição de entregador só é enviada para a sala da
célula onde ele está. O app interpola o marcador entre uma posição e a seguinte, por isso o
movimento é contínuo. Entregador em entrega some do mapa público e passa a ser visto só por quem
acompanha aquele pedido (as partes e quem tem o link `/t/CÓDIGO`).

**Despacho.** O pedido é oferecido aos entregadores livres mais próximos da coleta (raio de 6 km,
que cresce a cada 20 s). O primeiro aceite vence, garantido por um `UPDATE ... WHERE status =
'requested'`. Sem aceite em 5 minutos o pedido expira e o cliente é avisado. Se o entregador
desiste antes da coleta, o pedido volta para a fila.

**Status.** `requested → accepted → at_pickup → picked_up → delivered`, além de `cancelled` e
`expired`. Cancelar só é possível antes da coleta.

**Preço.** Tarifa base + valor por km, por país (CDF, BRL, USD), com fator por veículo, em
`server/src/config.ts`. Coleta e entrega precisam estar no mesmo país.

## Serviços externos e limites conhecidos

| Função | Serviço padrão | Trocar por |
| --- | --- | --- |
| Mapa vetorial | OpenFreeMap (dados OpenStreetMap) | `VITE_TILES_URL`, `VITE_GLYPHS_URL` |
| Busca de endereço | Nominatim público (limite de 1 req/s) | `VITE_GEOCODER_URL` |
| Rota pelas ruas | servidor de demonstração OSRM | `VITE_OSRM_URL` |

Os serviços públicos de busca e rota servem para testar; com usuários reais, hospede os seus ou
contrate um provedor. Se a rota não responder, o app traça a linha direta.

Ainda não incluído: pagamento no app, verificação do telefone por SMS, envio de documentos do
entregador, avaliação pós-entrega. Numa PWA o GPS para quando a tela bloqueia (o app mantém a tela
acesa enquanto o entregador está online); rastreamento em segundo plano pede empacotar com
Capacitor. Para mais de uma instância do servidor, mova o estado de `hub.ts` para Redis e use o
adaptador Redis do Socket.IO.
