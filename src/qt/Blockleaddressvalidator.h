// Copyright (c) 2011-2014 The Blockle Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef PALLADIUM_QT_PALLADIUMADDRESSVALIDATOR_H
#define PALLADIUM_QT_PALLADIUMADDRESSVALIDATOR_H

#include <QValidator>

/** Base58 entry widget validator, checks for valid characters and
 * removes some whitespace.
 */
class BlockleAddressEntryValidator : public QValidator
{
    Q_OBJECT

public:
    explicit BlockleAddressEntryValidator(QObject *parent);

    State validate(QString &input, int &pos) const;
};

/** Blockle address widget validator, checks for a valid blockle address.
 */
class BlockleAddressCheckValidator : public QValidator
{
    Q_OBJECT

public:
    explicit BlockleAddressCheckValidator(QObject *parent);

    State validate(QString &input, int &pos) const;
};

#endif // PALLADIUM_QT_PALLADIUMADDRESSVALIDATOR_H
