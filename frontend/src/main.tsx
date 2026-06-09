import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// Roteamento por pathname (sem react-router): /loja/<id> é a vitrine pública do
// cliente final; o resto é o painel da loja/admin. Os dois entram por import()
// dinâmico, então o Vite gera chunks separados — o cliente da vitrine nunca
// baixa o código (pesado) do painel, e vice-versa.
const ehVitrine = /^\/loja(\/|$)/.test(window.location.pathname)
const Raiz = lazy(() => (ehVitrine ? import('./cliente/PainelCliente.tsx') : import('./App.tsx')))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Raiz />
    </Suspense>
  </StrictMode>,
)
