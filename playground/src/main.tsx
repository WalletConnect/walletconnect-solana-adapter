import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { SolanaContext } from './SolanaContext.tsx'
import '@reown/appkit-polyfills'

ReactDOM.createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<SolanaContext>
			<App />
		</SolanaContext>
	</React.StrictMode>,
)
