import { Transaction, VersionedTransaction, PublicKey } from '@solana/web3.js'
import type { WalletConnectModal } from '@walletconnect/solana-adapter-ui'
import { UniversalProvider, type ConnectParams } from '@walletconnect/universal-provider'
import type { SessionTypes, SignClientTypes } from '@walletconnect/types'
import { parseAccountId } from '@walletconnect/utils'
import base58 from 'bs58'
import { ClientNotInitializedError } from './errors.js'
import { getChainsFromChainId, getDefaultChainFromSession } from './utils/chainIdPatch.js'
import { WalletConnectionError } from '@solana/wallet-adapter-base'

type UniversalProviderType = Awaited<ReturnType<typeof UniversalProvider.init>>

export interface WalletConnectWalletAdapterConfig {
	network: WalletConnectChainID
	options: SignClientTypes.Options
}

export enum WalletConnectChainID {
	Mainnet = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	Devnet = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
	Deprecated_Mainnet = 'solana:4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ',
	Deprecated_Devnet = 'solana:8E9rvCKLFQia2Y35HXjjpWzj8weVo44K',
}

export enum WalletConnectRPCMethods {
	signTransaction = 'solana_signTransaction',
	signMessage = 'solana_signMessage',
	signAndSendTransaction = 'solana_signAndSendTransaction',
	signAllTransactions = 'solana_signAllTransactions',
}

interface WalletConnectWalletInit {
	publicKey: PublicKey
}

const getConnectParams = (chainId: WalletConnectChainID): ConnectParams => {
	/** Workaround to support old chain Id configuration */
	const chains = getChainsFromChainId(chainId)

	return {
		optionalNamespaces: {
			solana: {
				chains,
				methods: [WalletConnectRPCMethods.signTransaction, WalletConnectRPCMethods.signMessage],
				events: [],
			},
		},
	}
}

const isVersionedTransaction = (transaction: Transaction | VersionedTransaction): transaction is VersionedTransaction =>
	'version' in transaction

export class WalletConnectWallet {
	private _UniversalProvider: UniversalProviderType | undefined
	private _session: SessionTypes.Struct | undefined
	private _modal: WalletConnectModal | undefined
	private _projectId: string
	private _network: WalletConnectChainID
	private _ConnectQueueResolver: ((value: unknown) => void) | undefined

	constructor(config: WalletConnectWalletAdapterConfig) {
		this.initClient(config.options)
		this._network = config.network

		if (!config.options.projectId) {
			throw Error('WalletConnect Adapter: Project ID is undefined')
		}
		this._projectId = config.options.projectId
	}

	async connect(): Promise<WalletConnectWalletInit> {
		if (!this._UniversalProvider) {
			await new Promise((res) => {
				this._ConnectQueueResolver = res
			})
		}
		if (!this._UniversalProvider) {
			throw new Error("WalletConnect Adapter - Universal Provider was undefined while calling 'connect()'")
		}

		if (this._UniversalProvider.session) {
			this._session = this._UniversalProvider.session
			const defaultNetwork = getDefaultChainFromSession(this._session, this._network) as WalletConnectChainID
			this._network = defaultNetwork
			this._UniversalProvider.setDefaultChain(defaultNetwork)
			return {
				publicKey: this.publicKey,
			}
		} else {
			try {
				// Lazy load the modal
				await this.initModal()
				//@ts-ignore AllWallets view type missing.
				this._modal?.open({ view: 'AllWallets' })
				let unsubscribeFromModalState: (() => void) | undefined
				const session: SessionTypes.Struct | undefined = await new Promise((res) => {
					unsubscribeFromModalState = this._modal?.subscribeState(({ open }) => {
						if (!open) {
							res(this._UniversalProvider?.session)
						}
					})
				})
				this._session = session
				unsubscribeFromModalState?.()
				if (!session) {
					throw new WalletConnectionError()
				}
				const defaultNetwork = getDefaultChainFromSession(session, this._network) as WalletConnectChainID
				this._network = defaultNetwork
				this._UniversalProvider?.setDefaultChain(defaultNetwork)

				return { publicKey: this.publicKey }
			} catch (error: unknown) {
				throw error
			}
		}
	}

	async disconnect() {
		if (this._UniversalProvider?.session) {
			// Lazy load the modal
			await this.initModal()
			if (!this._modal) throw Error('WalletConnect Adapter -Modal is undefined: unable to disconnect')
			await this._modal.disconnect()
			this._session = undefined
		} else {
			throw new ClientNotInitializedError()
		}
	}

	get client(): UniversalProviderType {
		if (this._UniversalProvider) {
			// TODO: using client.off throws an error
			return this._UniversalProvider
			// return this._client;
		} else {
			throw new ClientNotInitializedError()
		}
	}

	get session(): SessionTypes.Struct {
		if (!this._session) {
			throw new ClientNotInitializedError()
		}

		return this._session
	}

	get publicKey(): PublicKey {
		if (this._UniversalProvider?.session && this._session) {
			const { address } = parseAccountId(this._session.namespaces.solana.accounts[0])

			return new PublicKey(address)
		} else {
			throw new ClientNotInitializedError()
		}
	}

	async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
		this.checkIfWalletSupportsMethod(WalletConnectRPCMethods.signTransaction)

		const isVersioned = isVersionedTransaction(transaction)

		const legacyTransaction = isVersioned ? {} : transaction

		const { signature, transaction: signedSerializedTransaction } = await this.client.client.request<{
			signature: string
			transaction?: string
		}>({
			chainId: this._network,
			topic: this.session.topic,
			request: {
				method: WalletConnectRPCMethods.signTransaction,
				params: {
					// Passing ...legacyTransaction is deprecated.
					// All new clients should rely on the `transaction` parameter.
					// The future versions will stop passing ...legacyTransaction.
					...legacyTransaction,
					// New base64-encoded serialized transaction request parameter
					transaction: this.serialize(transaction),
				},
			},
		})

		if (signedSerializedTransaction) {
			return this.deserialize(signedSerializedTransaction, isVersioned) as T
		}

		transaction.addSignature(this.publicKey, Buffer.from(base58.decode(signature)))

		return transaction
	}

	async signMessage(message: Uint8Array): Promise<Uint8Array> {
		this.checkIfWalletSupportsMethod(WalletConnectRPCMethods.signMessage)

		const { signature } = await this.client.client.request<{
			signature: string
		}>({
			// The network does not change the output of message signing, but this is a required parameter for SignClient
			chainId: this._network,
			topic: this.session.topic,
			request: {
				method: WalletConnectRPCMethods.signMessage,
				params: {
					pubkey: this.publicKey.toString(),
					message: base58.encode(message),
				},
			},
		})

		return base58.decode(signature)
	}

	async signAndSendTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<string> {
		this.checkIfWalletSupportsMethod(WalletConnectRPCMethods.signAndSendTransaction)

		const { signature } = await this.client.client.request<{
			signature: string
		}>({
			chainId: this._network,
			topic: this.session.topic,
			request: {
				method: WalletConnectRPCMethods.signAndSendTransaction,
				params: { transaction: this.serialize(transaction) },
			},
		})

		return signature
	}

	async signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> {
		try {
			this.checkIfWalletSupportsMethod(WalletConnectRPCMethods.signAllTransactions)

			const serializedTransactions = transactions.map((transaction) => this.serialize(transaction))

			const { transactions: serializedSignedTransactions } = await this.client.client.request<{
				transactions: string[]
			}>({
				chainId: this._network,
				topic: this.session.topic,
				request: {
					method: WalletConnectRPCMethods.signAllTransactions,
					params: { transactions: serializedTransactions },
				},
			})

			return transactions.map((transaction, index) => {
				if (isVersionedTransaction(transaction)) {
					return this.deserialize(serializedSignedTransactions[index], true)
				}

				return this.deserialize(serializedSignedTransactions[index])
			}) as T[]
		} catch (error) {
			if (error instanceof WalletConnectFeatureNotSupportedError) {
				const signedTransactions = []
				for (const transaction of transactions) {
					signedTransactions.push(await this.signTransaction(transaction))
				}
				return signedTransactions as T[]
			}

			throw error
		}
	}

	async initClient(options: SignClientTypes.Options) {
		const provider = await UniversalProvider.init(options)
		this._UniversalProvider = provider
		if (this._ConnectQueueResolver) this._ConnectQueueResolver(true)
	}

	async initModal() {
		if (this._modal) return
		if (!this._UniversalProvider)
			throw new Error('WalletConnect Adapter - cannot init modal when Universal Provider is undefined')

		const { WalletConnectModal } = await import('@walletconnect/solana-adapter-ui')

		this._modal = new WalletConnectModal({
			projectId: this._projectId,
			universalProvider: this._UniversalProvider,
			namespaces: getConnectParams(this._network).optionalNamespaces as Exclude<
				ConnectParams['optionalNamespaces'],
				undefined
			>,
		})
	}

	private serialize(transaction: Transaction | VersionedTransaction): string {
		return Buffer.from(transaction.serialize({ verifySignatures: false })).toString('base64')
	}

	private deserialize(serializedTransaction: string, versioned = false): Transaction | VersionedTransaction {
		if (versioned) {
			return VersionedTransaction.deserialize(Buffer.from(serializedTransaction, 'base64'))
		}

		return Transaction.from(Buffer.from(serializedTransaction, 'base64'))
	}

	private checkIfWalletSupportsMethod(method: WalletConnectRPCMethods) {
		if (!this.session.namespaces['solana']?.methods.includes(method)) {
			throw new WalletConnectFeatureNotSupportedError(method)
		}
	}
}

export class WalletConnectFeatureNotSupportedError extends Error {
	constructor(method: WalletConnectRPCMethods) {
		super(`WalletConnect Adapter - Method ${method} is not supported by the wallet`)
		this.name = 'WalletConnectFeatureNotSupportedError'
	}
}
