// Copyright (c) 2015-2019 The Blockle Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef PALLADIUM_ZMQ_ZMQNOTIFICATIONINTERFACE_H
#define PALLADIUM_ZMQ_ZMQNOTIFICATIONINTERFACE_H

#include <validationinterface.h>
#include <list>

class CBlockIndex;
class CZMQAbstractNotifier;

class CZMQNotificationInterface final : public CValidationInterface
{
public:
    virtual ~CZMQNotificationInterface();

    std::list<const CZMQAbstractNotifier*> GetActiveNotifiers() const;

    static CZMQNotificationInterface* Create();

protected:
    bool Initialize();
    void Shutdown();

    // CValidationInterface
    void TransactionAddedToMempool(const CTransactionRef& tx) override;
    void BlockConnected(const std::shared_ptr<const CBlock>& pblock, const CBlockIndex* pindexConnected) override;
    void BlockDisconnected(const std::shared_ptr<const CBlock>& pblock, const CBlockIndex* pindexDisconnected) override;
    void UpdatedBlockTip(const CBlockIndex *pindexNew, const CBlockIndex *pindexFork, bool fInitialDownload) override;

private:
    CZMQNotificationInterface();

    void *pcontext;
    std::list<CZMQAbstractNotifier*> notifiers;
};

extern CZMQNotificationInterface* g_zmq_notification_interface;

#endif // PALLADIUM_ZMQ_ZMQNOTIFICATIONINTERFACE_H
