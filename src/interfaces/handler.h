// Copyright (c) 2018-2019 The Blockle Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef PALLADIUM_INTERFACES_HANDLER_H
#define PALLADIUM_INTERFACES_HANDLER_H

#include <functional>
#include <memory>

namespace boost {
namespace signals2 {
class connection;
} // namespace signals2
} // namespace boost

namespace interfaces {

//! Generic interface for managing an event handler or callback function
//! registered with another interface. Has a single disconnect method to cancel
//! the registration and prevent any future notifications.
class Handler
{
public:
    virtual ~Handler() {}

    //! Disconnect the handler.
    virtual void disconnect() = 0;
};

//! Return handler wrapping a boost signal connection.
std::unique_ptr<Handler> MakeHandler(boost::signals2::connection connection);

//! Return handler wrapping a cleanup function.
std::unique_ptr<Handler> MakeHandler(std::function<void()> cleanup);

} // namespace interfaces

#endif // PALLADIUM_INTERFACES_HANDLER_H
