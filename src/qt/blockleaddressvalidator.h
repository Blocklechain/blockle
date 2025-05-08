// Copyright (c) 2011-2014 The blockle Core developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.

#ifndef PALLADIUM_QT_PALLADIUMADDRESSVALIDATOR_H
#define PALLADIUM_QT_PALLADIUMADDRESSVALIDATOR_H

#include <QValidator>

/** Base58 entry widget validator, checks for valid characters and
 * removes some whitespace.
 */
class blockleAddressEntryValidator : public QValidator
{
    Q_OBJECT

public:
    explicit blockleAddressEntryValidator(QObject *parent);

    State validate(QString &input, int &pos) const;
};

/** blockle address widget validator, checks for a valid blockle address.
 */
class blockleAddressCheckValidator : public QValidator
{
    Q_OBJECT

public:
    explicit blockleAddressCheckValidator(QObject *parent);

    State validate(QString &input, int &pos) const;
};

#endif // PALLADIUM_QT_PALLADIUMADDRESSVALIDATOR_H
