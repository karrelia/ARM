# Генерує вихідники зовнішньої обробки 1С (формат вивантаження 2.12) для
# «Файл → Завантажити зовнішню обробку, звіт з файлів» у Конфігураторі.
# Запуск: python 1c/build_epf_src.py [тека]   (за замовчуванням 1c/epf/)
# Для збирання скриптом як інші обробки:
#   python 1c/build_epf_src.py "D:\ОБРОБКА 1С\ЗавантаженняПоказниківТеплооблік\src"
#   і там build-epf.cmd
import os, uuid, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
NAME = 'ЗавантаженняПоказниківТеплооблік'
import sys
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'epf')
_seq = [0]
def U():
    # стабільні uuid — щоб повторна генерація не міняла файли без потреби
    _seq[0] += 1
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'arm-teploobl/' + NAME + '/' + str(_seq[0])))

NS = ('xmlns="http://v8.1c.ru/8.3/MDClasses" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" '
      'xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:cmi="http://v8.1c.ru/8.2/managed-application/cmi" '
      'xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" '
      'xmlns:style="http://v8.1c.ru/8.1/data/ui/style" xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" '
      'xmlns:v8="http://v8.1c.ru/8.1/data/core" xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" '
      'xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xen="http://v8.1c.ru/8.3/xcf/enums" '
      'xmlns:xpr="http://v8.1c.ru/8.3/xcf/predef" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" '
      'xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.12"')
NSF = ('xmlns="http://v8.1c.ru/8.3/xcf/logform" xmlns:app="http://v8.1c.ru/8.2/managed-application/core" '
       'xmlns:cfg="http://v8.1c.ru/8.1/data/enterprise/current-config" xmlns:dcscor="http://v8.1c.ru/8.1/data-composition-system/core" '
       'xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings" xmlns:ent="http://v8.1c.ru/8.1/data/enterprise" '
       'xmlns:lf="http://v8.1c.ru/8.2/managed-application/logform" xmlns:style="http://v8.1c.ru/8.1/data/ui/style" '
       'xmlns:sys="http://v8.1c.ru/8.1/data/ui/fonts/system" xmlns:v8="http://v8.1c.ru/8.1/data/core" '
       'xmlns:v8ui="http://v8.1c.ru/8.1/data/ui" xmlns:web="http://v8.1c.ru/8.1/data/ui/colors/web" '
       'xmlns:win="http://v8.1c.ru/8.1/data/ui/colors/windows" xmlns:xr="http://v8.1c.ru/8.3/xcf/readable" '
       'xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="2.12"')

def title(uk, ru=None):
    s = '<v8:item><v8:lang>uk</v8:lang><v8:content>%s</v8:content></v8:item>' % uk
    if ru: s = '<v8:item><v8:lang>ru</v8:lang><v8:content>%s</v8:content></v8:item>' % ru + s
    return s

T_STR = '<v8:Type>xs:string</v8:Type><v8:StringQualifiers><v8:Length>0</v8:Length><v8:AllowedLength>Variable</v8:AllowedLength></v8:StringQualifiers>'
T_NUM = '<v8:Type>xs:decimal</v8:Type><v8:NumberQualifiers><v8:Digits>15</v8:Digits><v8:FractionDigits>3</v8:FractionDigits><v8:AllowedSign>Any</v8:AllowedSign></v8:NumberQualifiers>'
T_INT = '<v8:Type>xs:decimal</v8:Type><v8:NumberQualifiers><v8:Digits>10</v8:Digits><v8:FractionDigits>0</v8:FractionDigits><v8:AllowedSign>Nonnegative</v8:AllowedSign></v8:NumberQualifiers>'
T_BOOL = '<v8:Type>xs:boolean</v8:Type>'
T_DATE = '<v8:Type>xs:dateTime</v8:Type><v8:DateQualifiers><v8:DateFractions>Date</v8:DateFractions></v8:DateQualifiers>'
T_LS = '<v8:Type>cfg:CatalogRef.ЛицевыеСчета</v8:Type>'
T_PU = '<v8:Type>cfg:CatalogRef.ПриборыУчета</v8:Type>'
T_DOC = ('<v8:Type>cfg:DocumentRef.АктСнятияПоказанийТеплосчетчика</v8:Type>'
         '<v8:Type>cfg:DocumentRef.ВводПоказанийПриборовОтопление</v8:Type>'
         '<v8:Type>cfg:DocumentRef.ВводПоказанийПриборовУчета</v8:Type>')

# колонки таблиці «Данные»: (ім'я, заголовок, тип, показувати, тільки читання)
COLS = [
    ('Пометка', '✓', T_BOOL, True, False),
    ('НомерУФайлі', 'Рядок', T_INT, True, True),
    ('Особовий', 'Особовий (файл)', T_STR, True, True),
    ('НомерЛічильника', '№ лічильника (файл)', T_STR, True, True),
    ('Метод', 'Метод 1С', T_STR, True, True),
    ('Показник', 'Показник', T_NUM, True, True),
    ('Попередній1С', 'Попередній (1С)', T_NUM, True, True),
    ('ДатаПопер1С', 'Дата попер. (1С)', T_DATE, True, True),
    ('Різниця', 'Різниця', T_NUM, True, True),
    ('Статус', 'Статус / що виправити', T_STR, True, True),
    ('ЛицевойСчет', 'Особовий у 1С', T_LS, True, True),
    ('ПриборУчета', 'Прилад у 1С', T_PU, True, True),
    ('Документ', 'Документ', T_DOC, True, True),
    ('ДатаЗняття', 'Дата зняття', T_DATE, True, True),
    ('Хто', 'Хто знімав', T_STR, False, True),
    ('Адреса', 'Адреса', T_STR, True, True),
    ('ЄПоказник', 'Є показник', T_BOOL, False, True),
    ('Помилка', 'Помилка', T_BOOL, False, True),
    ('Попередження', 'Попередження', T_BOOL, False, True),
    ('Дод', 'Додаткові параметри', T_STR, False, True),
]

class Ids:
    def __init__(self): self.n = 0
    def __call__(self): self.n += 1; return self.n
ID = Ids()

def extras(name):
    return ('<ContextMenu name="%sКонтекстноеМеню" id="%d"/><ExtendedTooltip name="%sРасширеннаяПодсказка" id="%d"/>'
            % (name, ID(), name, ID()))

def input_field(name, path, ttl=None, ro=False, events='', extra=''):
    return ('<InputField name="%s" id="%d"><DataPath>%s</DataPath>%s%s<EditMode>EnterOnInput</EditMode>%s%s%s</InputField>'
            % (name, ID(), path, ('<ReadOnly>true</ReadOnly>' if ro else ''),
               ('<Title>%s</Title>' % title(ttl) if ttl else ''), extra, extras(name), events))

def check_field(name, path, ttl=None, events='', right=False):
    return ('<CheckBoxField name="%s" id="%d"><DataPath>%s</DataPath>%s%s<CheckBoxType>Auto</CheckBoxType>%s%s</CheckBoxField>'
            % (name, ID(), path, ('<Title>%s</Title>' % title(ttl) if ttl else ''),
               ('<TitleLocation>Right</TitleLocation>' if right else ''), extras(name), events))

def ev(*pairs):
    return '<Events>' + ''.join('<Event name="%s">%s</Event>' % p for p in pairs) + '</Events>'

def button(name, cmd):
    return ('<Button name="%s" id="%d"><Type>CommandBarButton</Type><CommandName>Form.Command.%s</CommandName>'
            '<ExtendedTooltip name="%sРасширеннаяПодсказка" id="%d"/></Button>' % (name, ID(), cmd, name, ID()))

def build_form():
    items = []
    items.append(input_field('ФайлЕксель', 'ФайлЕксель', 'Файл «Повний список» із застосунку',
                             extra='<ChoiceButton>true</ChoiceButton><ClearButton>true</ClearButton>',
                             events=ev(('StartChoice', 'ФайлЕксельНачалоВыбора'))))
    items.append(input_field('ДатаПоказань', 'ДатаПоказань', 'Звітний місяць (будь-яка дата місяця)',
                             events=ev(('OnChange', 'ДатаПоказаньПриИзменении'))))
    items.append(check_field('Проводити', 'Проводити', 'Проводити документи', right=True))
    items.append(check_field('ЛишеПроблемні', 'ЛишеПроблемні', 'Показати лише помилки (що треба виправити)', right=True,
                             events=ev(('OnChange', 'ЛишеПроблемніПриИзменении'))))
    items.append('<LabelField name="Підсумок" id="%d"><DataPath>Підсумок</DataPath><TitleLocation>None</TitleLocation>%s</LabelField>'
                 % (ID(), extras('Підсумок')))
    # таблиця
    tid = ID()
    cols = []
    for (n, t, ty, show, ro) in COLS:
        if not show: continue
        el = 'Данные' + n
        if n == 'Пометка':
            cols.append(check_field(el, 'Данные.' + n, t))
        else:
            cols.append(input_field(el, 'Данные.' + n, t, ro=ro))
    bar = ''.join([button('КнПрочитати', 'ПрочитатиІПеревірити'), button('КнПеревірити', 'ПеревіритиЩеРаз'),
                   button('КнСтворити', 'СтворитиДокументи'), button('КнПозначити', 'ПозначитиВсіБезПомилок'),
                   button('КнЗняти', 'ЗнятиПозначки')])
    def add(kind, typ):
        return ('<%s name="Данные%s" id="%d"><AdditionSource><Item>Данные</Item><Type>%s</Type></AdditionSource>'
                '<ContextMenu name="Данные%sКонтекстноеМеню" id="%d"/><ExtendedTooltip name="Данные%sРасширеннаяПодсказка" id="%d"/></%s>'
                % (kind[0], kind[1], ID(), typ, kind[1], ID(), kind[1], ID(), kind[0]))
    table = ('<Table name="Данные" id="%d"><Representation>List</Representation><ChangeRowSet>false</ChangeRowSet>'
             '<DataPath>Данные</DataPath><RowFilter xsi:nil="true"/>'
             '<ContextMenu name="ДанныеКонтекстноеМеню" id="%d"/>'
             '<AutoCommandBar name="ДанныеКоманднаяПанель" id="%d"><ChildItems>%s</ChildItems></AutoCommandBar>'
             '<ExtendedTooltip name="ДанныеРасширеннаяПодсказка" id="%d"/>%s%s%s'
             '<ChildItems>%s</ChildItems></Table>'
             % (tid, ID(), ID(), bar, ID(),
                add(('SearchStringAddition', 'СтрокаПоиска'), 'SearchStringRepresentation'),
                add(('ViewStatusAddition', 'СостояниеПросмотра'), 'ViewStatusRepresentation'),
                add(('SearchControlAddition', 'УправлениеПоиском'), 'SearchControl'),
                ''.join(cols)))
    items.append(table)

    attrs = ['<Attribute name="Объект" id="1"><Type><v8:Type>cfg:ExternalDataProcessorObject.%s</v8:Type></Type>'
             '<MainAttribute>true</MainAttribute></Attribute>' % NAME]
    aid = 2
    for (n, t, ty) in [('ФайлЕксель', 'Файл', T_STR), ('ДатаПоказань', 'Звітний місяць', T_DATE),
                       ('Проводити', 'Проводити документи', T_BOOL), ('ЛишеПроблемні', 'Лише помилки', T_BOOL),
                       ('Підсумок', 'Підсумок', T_STR)]:
        attrs.append('<Attribute name="%s" id="%d"><Title>%s</Title><Type>%s</Type></Attribute>' % (n, aid, title(t), ty)); aid += 1
    ccols = ''.join('<Column name="%s" id="%d"><Title>%s</Title><Type>%s</Type></Column>' % (n, i + 1, title(t), ty)
                    for i, (n, t, ty, s, r) in enumerate(COLS))
    attrs.append('<Attribute name="Данные" id="%d"><Title>%s</Title><Type><v8:Type>v8:ValueTable</v8:Type></Type><Columns>%s</Columns></Attribute>'
                 % (aid, title('Дані'), ccols))

    cmds = []
    for i, (n, t, tip) in enumerate([
        ('ПрочитатиІПеревірити', 'Прочитати й перевірити', 'Прочитати файл і зіставити з 1С'),
        ('ПеревіритиЩеРаз', 'Перевірити ще раз', 'Після виправлень у 1С — зіставити знову'),
        ('СтворитиДокументи', 'Створити документи', 'Створити документи для позначених рядків'),
        ('ПозначитиВсіБезПомилок', 'Позначити всі без помилок', 'Позначити рядки без помилок (разом із попередженнями)'),
        ('ЗнятиПозначки', 'Зняти позначки', 'Зняти всі позначки')]):
        cmds.append('<Command name="%s" id="%d"><Title>%s</Title><ToolTip>%s</ToolTip><Action>%s</Action></Command>'
                    % (n, i + 1, title(t), title(tip), n))

    return ('﻿<?xml version="1.0" encoding="UTF-8"?>\n<Form %s>'
            '<Title>%s</Title><AutoTitle>false</AutoTitle>'
            '<AutoCommandBar name="ФормаКоманднаяПанель" id="-1"/>'
            '%s<ChildItems>%s</ChildItems><Attributes>%s</Attributes><Commands>%s</Commands></Form>'
            % (NSF, title('Завантаження показників Теплооблік'), ev(('OnCreateAtServer', 'ПриСозданииНаСервере')),
               ''.join(items), ''.join(attrs), ''.join(cmds)))

def main():
    if os.path.isdir(OUT): shutil.rmtree(OUT)
    fdir = os.path.join(OUT, NAME, 'Forms', 'Форма', 'Ext', 'Form')
    os.makedirs(fdir)
    root = ('﻿<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject %s><ExternalDataProcessor uuid="%s"><InternalInfo>'
            '<xr:GeneratedType name="ExternalDataProcessorObject.%s" category="Object"><xr:TypeId>%s</xr:TypeId><xr:ValueId>%s</xr:ValueId></xr:GeneratedType>'
            '</InternalInfo><Properties><Name>%s</Name><Synonym>%s</Synonym><Comment/>'
            '<DefaultForm>ExternalDataProcessor.%s.Form.Форма</DefaultForm><AuxiliaryForm/></Properties>'
            '<ChildObjects><Form>Форма</Form></ChildObjects></ExternalDataProcessor></MetaDataObject>'
            % (NS, U(), NAME, U(), U(), NAME, title('Завантаження показників Теплооблік', 'Загрузка показаний Теплооблик'), NAME))
    form_md = ('﻿<?xml version="1.0" encoding="UTF-8"?>\n<MetaDataObject %s><Form uuid="%s"><Properties><Name>Форма</Name>'
               '<Synonym>%s</Synonym><Comment/><FormType>Managed</FormType><IncludeHelpInContents>false</IncludeHelpInContents>'
               '<UsePurposes><v8:Value xsi:type="app:ApplicationUsePurpose">PlatformApplication</v8:Value>'
               '<v8:Value xsi:type="app:ApplicationUsePurpose">MobilePlatformApplication</v8:Value></UsePurposes>'
               '<ExtendedPresentation/></Properties></Form></MetaDataObject>' % (NS, U(), title('Форма', 'Форма')))
    w = lambda p, t: open(p, 'w', encoding='utf-8', newline='\r\n').write(t)
    w(os.path.join(OUT, NAME + '.xml'), root)
    w(os.path.join(OUT, NAME, 'Forms', 'Форма.xml'), form_md)
    w(os.path.join(OUT, NAME, 'Forms', 'Форма', 'Ext', 'Form.xml'), build_form())
    mod = open(os.path.join(ROOT, 'src', 'Module.bsl'), encoding='utf-8-sig').read()
    w(os.path.join(fdir, 'Module.bsl'), '﻿' + mod.replace('\r\n', '\n'))
    print('ok:', OUT)

if __name__ == '__main__':
    main()
