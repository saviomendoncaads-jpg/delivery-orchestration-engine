import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// Roteamento por pathname (sem react-router): /loja/<id> é a vitrine pública do
// cliente final; o resto é o painel da loja/admin. Os dois entram por import()
// dinâmico, então o Vite gera chunks separados — o cliente da vitrine nunca
// baixa o código (pesado) do painel, e vice-versa.
// IMPORTANTE: cada import() precisa ficar no SEU PRÓPRIO lazy(). Com os dois
// dentro de um condicional único, o Vite anexa a lista de CSS de só um chunk
// aos dois ramos — a vitrine carregava o App.css e ficava sem o cliente.css.
const PainelCliente = lazy(() => import('./cliente/PainelCliente.tsx'))
const App = lazy(() => import('./App.tsx'))
const ehVitrine = /^\/loja(\/|$)/.test(window.location.pathname)
const Raiz = ehVitrine ? PainelCliente : App

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Raiz />
    </Suspense>
  </StrictMode>,
)
