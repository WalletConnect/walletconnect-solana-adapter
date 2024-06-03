import { Transaction, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { WalletConnectModal } from '@walletconnect/modal';
import WalletConnectClient from '@walletconnect/sign-client';
import type { EngineTypes, SessionTypes, SignClientTypes } from '@walletconnect/types';
import { getSdkError, parseAccountId } from '@walletconnect/utils';
import base58 from 'bs58';
import { ClientNotInitializedError, QRCodeModalError } from './errors.js';

export interface WalletConnectWalletAdapterConfig {
    network: WalletConnectChainID;
    options: SignClientTypes.Options;
}

export enum WalletConnectChainID {
    Mainnet = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    Devnet = 'solana:8E9rvCKLFQia2Y35HXjjpWzj8weVo44K',
}

export enum WalletConnectRPCMethods {
    signTransaction = 'solana_signTransaction',
    signMessage = 'solana_signMessage',
}

interface WalletConnectWalletInit {
    publicKey: PublicKey;
}

const getConnectParams = (chainId: WalletConnectChainID): EngineTypes.FindParams => ({
    requiredNamespaces: {
        solana: {
            chains: [chainId],
            methods: [WalletConnectRPCMethods.signTransaction, WalletConnectRPCMethods.signMessage],
            events: [],
        },
    },
});

const isVersionedTransaction = (transaction: Transaction | VersionedTransaction): transaction is VersionedTransaction =>
    'version' in transaction;

export class WalletConnectWallet {
    private _client: WalletConnectClient | undefined;
    private _session: SessionTypes.Struct | undefined;
    private _modal: WalletConnectModal;
    private readonly _network: WalletConnectChainID;
    private readonly _options: SignClientTypes.Options;

    constructor(config: WalletConnectWalletAdapterConfig) {
        this._options = config.options;
        this._network = config.network;

        this._modal = new WalletConnectModal({
            projectId: this._options.projectId!,
            chains: [this._network],
        });
    }

    async connect(): Promise<WalletConnectWalletInit> {
        const client = this._client ?? (await WalletConnectClient.init(this._options));
        const sessions = client.find(getConnectParams(this._network)).filter((s) => s.acknowledged);
        if (sessions.length) {
            // select last matching session
            this._session = sessions[sessions.length - 1];
            // We assign this variable only after we're sure we've received approval
            this._client = client;

            return {
                publicKey: this.publicKey,
            };
        } else {
            const { uri, approval } = await client.connect(getConnectParams(this._network));
            return new Promise((resolve, reject) => {
                this._modal.subscribeModal((state) => {
                    // the modal was closed so reject the promise
                    if (!state.open && !this._session) {
                        reject(new Error('Connection request reset. Please try again.'));
                    }
                });

                if (uri) {
                    this._modal.openModal({ uri }).catch(() => {
                        reject(new QRCodeModalError());
                    });
                }

                approval()
                    .then((session) => {
                        this._session = session;
                        // We assign this variable only after we're sure we've received approval
                        this._client = client;

                        resolve({ publicKey: this.publicKey });
                    })
                    .catch(reject)
                    .finally(() => {
                        this._modal.closeModal();
                    });
            });
        }
    }

    async disconnect() {
        if (this._client && this._session) {
            await this._client.disconnect({
                topic: this._session.topic,
                reason: getSdkError('USER_DISCONNECTED'),
            });
            this._session = undefined;
        } else {
            throw new ClientNotInitializedError();
        }
    }

    get client(): WalletConnectClient {
        if (this._client) {
            // TODO: using client.off throws an error
            return Object.assign({}, this._client, { off: this._client.removeListener });
            // return this._client;
        } else {
            throw new ClientNotInitializedError();
        }
    }

    get publicKey(): PublicKey {
        if (this._client && this._session) {
            const { address } = parseAccountId(this._session.namespaces.solana.accounts[0]);
            return new PublicKey(address);
        } else {
            throw new ClientNotInitializedError();
        }
    }

    async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
        if (this._client && this._session) {
            let rawTransaction: string;
            let legacyTransaction: Transaction | VersionedTransaction | undefined;

            if (isVersionedTransaction(transaction)) {
                // V0 transactions are serialized and passed in the `transaction` property
                rawTransaction = Buffer.from(transaction.serialize()).toString('base64');

                if (transaction.version === 'legacy') {
                    // For backwards-compatible, legacy transactions are spread in the params
                    legacyTransaction = Transaction.from(transaction.serialize());
                }
            } else {
                rawTransaction = transaction
                    .serialize({
                        requireAllSignatures: false,
                        verifySignatures: false,
                    })
                    .toString('base64');
                legacyTransaction = transaction;
            }

            const { signature } = await this._client.request<{ signature: string }>({
                chainId: this._network,
                topic: this._session.topic,
                request: {
                    method: WalletConnectRPCMethods.signTransaction,
                    params: {
                        // Passing ...legacyTransaction is deprecated.
                        // All new clients should rely on the `transaction` parameter.
                        // The future versions will stop passing ...legacyTransaction.
                        ...legacyTransaction,
                        // New base64-encoded serialized transaction request parameter
                        transaction: rawTransaction,
                    },
                },
            });
            transaction.addSignature(this.publicKey, Buffer.from(base58.decode(signature)));

            return transaction;
        } else {
            throw new ClientNotInitializedError();
        }
    }

    async signMessage(message: Uint8Array): Promise<Uint8Array> {
        if (this._client && this._session) {
            const { signature } = await this._client.request<{ signature: string }>({
                // The network does not change the output of message signing, but this is a required parameter for SignClient
                chainId: this._network,
                topic: this._session.topic,
                request: {
                    method: WalletConnectRPCMethods.signMessage,
                    params: { pubkey: this.publicKey.toString(), message: base58.encode(message) },
                },
            });

            return base58.decode(signature);
        } else {
            throw new ClientNotInitializedError();
        }
    }
}
